import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig, type MemoryConfig, type SessionPersistenceConfig } from "./src/config";
import { runDream } from "./src/dream";
import { indexCapacity, parseEntryIndex } from "./src/entry-index";
import { runExtract } from "./src/extract";
import { readLockStatus } from "./src/fs-lock";
import { readRecordedMemoryIndex } from "./src/index-source";
import { applyIndexSection, buildIndexSection, buildInjection, injectSurfacedContent, runSideQuery, scanEntries } from "./src/inject";
import {
	createMemoryTool,
	DREAM_ACTIONS,
	MAIN_AGENT_ACTIONS,
	type MemoryToolDeps,
} from "./src/memory-tool";
import { LOCK_FILE, MemoryStore } from "./src/memory-store";
import { MIGRATED_FILE, migrateIfNeeded } from "./src/migrate";
import { readDreamMeta, shouldNudge, writeDreamMeta } from "./src/nudge";
import { resolveMemoryDir } from "./src/paths";
import { searchSessions } from "./src/session-search";

function extractAgentsMdBlocks(systemPrompt: string): string[] {
	const blocks: string[] = [];
	const re = /<project_instructions\s+path="([^"]+)">\n([\s\S]*?)<\/project_instructions>/g;
	for (const match of systemPrompt.matchAll(re)) {
		blocks.push(match[0]);
	}
	return blocks;
}

/**
 * dream 的两条 fire-and-forget 链（session_start 的 nudge 与 `/dream`）共用的收尾工具。
 * handler 在**同步段**把 `ctx.ui` 快照成 `ExtensionUIContext | undefined`，链里一律不再读 `ctx`：
 * pi 的 `ExtensionContext` 是代理，`hasUI` / `ui` 的 getter 会 `assertActive()`，session dispose
 * （/new、切换、fork、reload）之后读取即抛错。dream 走 600s timeout，而 `session_shutdown`
 * 只等 `lock.timeoutMs`（默认 5s），所以「dream 在途 + session 已销毁」是常态路径；通知 / 清状态
 * 自己抛错也不能逃逸成未处理 rejection（没有全局 handler 时 Node 会直接杀掉进程）。
 */
function notifyDream(ui: ExtensionUIContext | undefined, message: string, level: "info" | "error"): void {
	try {
		ui?.notify(message, level);
	} catch {
		/* UI 已失效：宿主不再收这条通知 */
	}
}

function clearDreamStatus(ui: ExtensionUIContext | undefined): void {
	try {
		ui?.setStatus("dream", undefined);
	} catch {
		/* UI 已失效 */
	}
}

/** rejected 的值不一定是 Error（pi 的模型层可能抛字符串 / 对象）。 */
function dreamFailureMessage(e: unknown): string {
	return `Dream failed: ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * `<relevant_memories>` 里实际注入的块数（每块以 `\n## ` 开头）。
 * 近似值：正文里自己以 `## ` 开头的行会被多算 —— 它只用于一条通知文案（spec §14），
 * 而把 `injectSurfacedContent` 的返回值改成结构体反而会弄脏 Plan B 已钉住的接口。
 */
function countInjectedBlocks(content: string): number {
	return Math.max(0, content.split("\n## ").length - 1);
}

/**
 * `/memory` 的迁移状态行（spec §14）。`.migrated` 由迁移在**最后一步**写（§15.3 步骤 6），
 * 所以「标记不在」= 还没迁完 = `pending`（下次 session_start 会重试）；
 * 标记读不懂也按 `pending` 报 —— 宁可让用户多看到一次重试，不可假装已经迁完。
 * `files`/`entries` 都是 0 则是「扫过了、根本没东西要迁」= `not needed`。
 */
async function readMigrationStatus(memoryDir: string): Promise<string> {
	try {
		const marker = JSON.parse(await readFile(join(memoryDir, MIGRATED_FILE), "utf8")) as {
			migratedAt?: unknown;
			entries?: unknown;
			files?: unknown;
		};
		if (
			typeof marker.migratedAt !== "string" ||
			typeof marker.entries !== "number" ||
			typeof marker.files !== "number"
		) {
			return "pending";
		}
		if (marker.files === 0 && marker.entries === 0) return "not needed";
		return `migrated at ${marker.migratedAt} (${marker.entries} entries from ${marker.files} files)`;
	} catch {
		return "pending";
	}
}

/**
 * `/memory` 的锁状态行。只读不碰 —— `.lock` **永不自动回收**（spec §5.1），
 * 人工清除只有 `/memory unlock` 一个入口。
 */
async function lockStatusLine(memoryDir: string): Promise<string> {
	const status = await readLockStatus(join(memoryDir, LOCK_FILE));
	if (status.kind === "absent") return "free";
	if (status.kind === "unreadable") return "unreadable — run /memory unlock";
	return `held by ${status.holder.op} (pid ${status.holder.pid}, started ${status.holder.startedAt})`;
}

/**
 * `/memory unlock`：崩溃遗留的 `.lock` 的**唯一**人工清除入口（spec §19 风险表）。
 * 必须显式 confirm，而且只删 `.lock` 本身 —— 删错了就是两个写入者同时持有锁。
 */
async function unlockMemory(memoryDir: string, ui: ExtensionUIContext): Promise<void> {
	const lockPath = join(memoryDir, LOCK_FILE);
	if ((await readLockStatus(lockPath)).kind === "absent") {
		ui.notify("No lock present.", "info");
		return;
	}
	const ok = await ui.confirm(
		"Memory lock",
		"Remove the memory lock file? Only do this if no memory operation is running.",
	);
	if (!ok) return;
	try {
		await unlink(lockPath);
		ui.notify("Memory lock removed.", "info");
	} catch (e) {
		// confirm 到 unlink 之间锁自己消失了：那正是想要的结果
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			ui.notify("No lock present.", "info");
			return;
		}
		ui.notify(`Failed to remove memory lock: ${(e as Error).message}`, "error");
	}
}

function resolveDefault(cfg: MemoryConfig, task: "dream" | "autoSurfacing" | "extractMemories", key: "model"): string | undefined;
function resolveDefault(cfg: MemoryConfig, task: "dream" | "autoSurfacing" | "extractMemories", key: "sessionPersistence"): SessionPersistenceConfig | undefined;
function resolveDefault(cfg: MemoryConfig, task: "dream" | "autoSurfacing" | "extractMemories", key: "model" | "sessionPersistence"): string | SessionPersistenceConfig | undefined {
	const perTask = cfg[task][key];
	if (perTask !== undefined) return perTask;
	return cfg.defaults?.[key];
}

export default function (pi: ExtensionAPI) {
	let memoryDir: string | null = null;
	let config: MemoryConfig | null = null;
	/** 唯一写入通道（D4）。session_start 里建，之后工具 / extract / dream 都只经它读写。 */
	let store: MemoryStore | null = null;
	let indexSnapshot = "";
	let toolRegistered = false;
	let currentCwd = "";
	/** 本 session 已注入过的 entry **文件名**（spec §9.3）。session_compact 会清空它。 */
	const injectedFiles = new Set<string>();
	let lastSystemPrompt = "";
	/** extract 失败通知的限流（spec §14：同一 session 最多 1 次）。session_start 重置。 */
	let extractErrorNotified = false;
	/**
	 * 在途的后台写操作（dream / extract）。`session_shutdown` 等它们收尾，上限
	 * `lock.timeoutMs`（spec §10）—— 进程在写入中途被杀会留下永远没人释放的 `.lock`。
	 */
	const inFlight = new Set<Promise<unknown>>();

	/** 登记一个后台 promise，settle 后自动摘掉；返回同一个 promise 以便调用方继续链式处理。 */
	function track<T>(promise: Promise<T>): Promise<T> {
		inFlight.add(promise);
		promise.catch(() => undefined).finally(() => inFlight.delete(promise));
		return promise;
	}

	/**
	 * 主 agent、extract、dream 共用同一份依赖，三者只差 `actions` 与锁/快照选项（D12）。
	 * 用 getter 而不是快照值：config / memoryDir / store 都在 session_start 里才确定。
	 */
	const toolDeps: MemoryToolDeps = {
		getMemoryDir: () => memoryDir,
		getStore: () => store,
		// biome-ignore lint/style/noNonNullAssertion: config 在 session_start 里赋值，工具执行必然晚于它
		getConfig: () => config!,
		getEnabled: () => config?.enabled ?? false,
		searchSessions,
		cwd: () => currentCwd,
	};

	/**
	 * 建立本 session 的记忆运行时：目录 → store → 迁移 → 索引来源 → 注册工具。
	 *
	 * `session_start` 与 `/memory on` 共用。以 `enabled: false` 启动的会话也必须能中途打开：
	 * 否则本 session 的 `memory` 工具永远报 "Memory not initialized"，而 `/memory unlock`
	 * （崩溃遗留 `.lock` 的**唯一**人工入口，spec §19）也不可达（Plan C ledger R50）。
	 *
	 * 返回 `false` 当且仅当 config 缺失或 `enabled` 为 false；抛错 = 初始化失败，由调用方决定
	 * 怎么收拾（`/memory on` 必须回滚开关，不得留下「enabled=true 但没有 store」的半状态）。
	 * `reason` 只有 `session_start` 会传：resume / fork / reload 用 transcript 的录制值（D14）。
	 */
	async function initMemory(ctx: ExtensionContext, reason?: string): Promise<boolean> {
		// 先拷到 const：`config` 是工厂作用域的 let，异步回调里 TS 不保留外层收窄。
		const cfg = config;
		if (!cfg?.enabled) return false;
		currentCwd = ctx.cwd;
		const dir = await resolveMemoryDir(cfg, ctx.cwd);
		const activeStore = new MemoryStore({
			memoryDir: dir,
			indexMaxLines: cfg.memIndexMaxLines,
			indexMaxBytes: cfg.memIndexMaxBytes,
			lock: cfg.lock,
		});
		memoryDir = dir;
		store = activeStore;

		// v1 → v2 的自动迁移（spec §15 / D10）。必须在算 indexSnapshot **之前**：
		// 否则本会话注入的是迁移前的旧索引。
		// 失败不能拖垮会话启动：记忆迁移不了也比整个会话起不来好，而且 `.migrated`
		// 未写 → 下次 session_start 会重试（spec §15.4）。
		try {
			const migration = await migrateIfNeeded(activeStore);
			if (migration && ctx.hasUI) {
				ctx.ui.notify(
					`Migrated ${migration.entries} memories from ${migration.files} topic files. Backup at ${migration.backupDir}`,
					"info",
				);
			}
		} catch (e) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Memory migration failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		}

		// D13 / D14：索引值在整个 session 内**冻结**。resume / fork / reload 必须用 transcript 里的
		// 录制值 —— 否则被恢复会话的 system prompt 头部会被改写，而 memory_index 是头部的最后一段，
		// 折叠路径下其后的整段对话全部失去缓存。录制值拿不到（更老的 session、旧 SDK 没有
		// sessionEntryToContextMessages）才回退磁盘读。
		// 录制值**不再 re-sanitize**：写入当年已经净化过，而 sanitizeForInjection 是幂等的 ——
		// 保持字节恒等更利于缓存。
		// `/memory on` 不传 reason：中途打开的会话没有可重放的录制值，从磁盘读。
		const useRecorded = reason === "resume" || reason === "fork" || reason === "reload";
		const recorded = useRecorded ? readRecordedMemoryIndex(ctx.sessionManager) : null;
		indexSnapshot =
			recorded ?? (await buildIndexSection(activeStore, cfg.memIndexInjectMaxLines, cfg.memIndexInjectMaxBytes));

		// register memory tool once
		if (!toolRegistered) {
			pi.registerTool(
				// biome-ignore lint/suspicious/noExplicitAny: pi registerTool type cast
				createMemoryTool(toolDeps) as any,
			);
			toolRegistered = true;
		}
		return true;
	}
	pi.on("session_start", async (event, ctx) => {
		// 先重置限流配额：本 session 若以 disabled 启动（下面提前 return），用户中途
		// `/memory on` 之后仍应拿到一次失败通知 —— 否则上一 session 残留的 true 会一直吞掉它。
		extractErrorNotified = false;
		config = await loadConfig(ctx);
		if (!config.enabled) {
			// 跨 session 复位：上一个 session 可能是 enabled 的、甚至 cwd 不同。留着的话，
			// 本 session 中途 `/memory on` 会拿上一个项目的 store 继续写（Plan C ledger R51）。
			memoryDir = null;
			store = null;
			indexSnapshot = "";
			injectedFiles.clear();
			return;
		}
		await initMemory(ctx, (event as { reason?: string }).reason);

		// nudge
		// 先拷到 const：initMemory 里赋的值，TS 在本函数的控制流里看不到收窄。
		const nudgeDir = memoryDir;
		if (ctx.hasUI && nudgeDir) {
			// 同步段快照：shouldNudge / confirm 之后的 fire-and-forget 链不再碰 ctx（见 notifyDream）。
			const ui = ctx.ui;
			const { nudge, message, sessions } = await shouldNudge(nudgeDir, config, ctx.cwd);
			if (nudge) {
				const ok = await ui.confirm("Memory Consolidation", `${message}\n\nConsolidate memory files now?`);
				// dream 需要 store（整轮逻辑锁 + 快照都挂在它上面）；这里必然非空，但 const 拷贝让 TS 也能看到。
				const activeStore = store;
				if (ok && activeStore) {
					// Fire-and-forget: does not block session_start. The headless
					// dream agent runs independently; completion notifies the user.
					const dreamModel = resolveDefault(config, "dream", "model");
					const dreamThinkLevel = config.dream.thinkLevel;
					const dir = nudgeDir;
					ui.setStatus("dream", "Consolidating memory...");
					const dreamRun = runDream({
						model: dreamModel,
						thinkLevel: dreamThinkLevel,
						memoryDir: dir,
						store: activeStore,
						maxLines: config.memIndexMaxLines,
						modelRegistry: ctx.modelRegistry,
						parentModel: ctx.model,
						sessionPersistence: resolveDefault(config, "dream", "sessionPersistence"),
						// dream 的 7 个 action 只注入它自己的 headless session（D12）；整轮持锁与
						// 进入时的全目录快照都在 runDream 里，所以内部原语两个选项都跳过。
						customTools: [
							createMemoryTool(toolDeps, {
								actions: DREAM_ACTIONS,
								skipLogicalLock: true,
								skipSnapshot: true,
							}),
						],
					});
					track(dreamRun);
					// 两参 `.then`（而不是 `.then().catch()`）：成功分支自己写 meta，两个分支都不再读 ctx；
					// writeDreamMeta 的失败也必须在分支内兜住，否则它会变成无人接管的 rejection。
					void dreamRun
						.then(
							async (summary) => {
								try {
									await writeDreamMeta(dir, sessions);
								} catch (e) {
									notifyDream(ui, dreamFailureMessage(e), "error");
									return;
								}
								notifyDream(ui, summary, "info");
							},
							(e: unknown) => notifyDream(ui, dreamFailureMessage(e), "error"),
						)
						.finally(() => clearDreamStatus(ui));
				}
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		lastSystemPrompt = event.systemPrompt;
		// 先拷到 const：`store` 是工厂作用域的 let，在异步回调里 TS 不会保留它的外层收窄。
		const activeStore = store;
		if (!config?.enabled || !memoryDir || !activeStore) return;

		// 索引 section：**每一轮无条件**写入冻结值（含 resume / fork / reload）。
		// 省略这个键 = pi 的 diffSystemPromptSections 生成 { memory_index: null } = 把索引从
		// system prompt 里静默删掉（spec §9.1 的 null 陷阱）。「不想改」只能靠喂回同一个值。
		// 必须在 auto-surfacing **之前**：surfacing 的 `finally` 在 await 之后读 `ctx.hasUI`，
		// session 在途中 dispose 会让 handler 从那里抛出（R49）——那时 section 已经被跳过，
		// 这一轮就从「喂回冻结值」变成了「删段」。
		const applied = applyIndexSection(event.systemPromptOptions, indexSnapshot);

		const autoSurfacing = config.autoSurfacing;
		// Skip auto-surfacing in subagent sessions: pi-subagents injects an
		// <active_agent name="..."/> tag into every subagent's system prompt.
		// Main sessions (including forks) never have this tag. Our own headless
		// sessions use noExtensions (never bind), so they never reach here.
		const isSubagent = event.systemPrompt?.includes("<active_agent name=\"");
		// biome-ignore lint/suspicious/noExplicitAny: message injection result
		let injectedMessage: any;
		if (autoSurfacing?.enabled && event.prompt && !isSubagent) {
			try {
				if (ctx.hasUI) ctx.ui.setStatus("surfacing", "Searching relevant memories…");
				const manifest = await scanEntries(activeStore);
				if (manifest.length > 0) {
					const selected = await runSideQuery(
						manifest,
						event.prompt.slice(0, 4000),
						injectedFiles,
						autoSurfacing.maxFiles,
						autoSurfacing.thinkLevel,
						resolveDefault(config, "autoSurfacing", "model"),
						ctx.modelRegistry,
						ctx.model,
						memoryDir,
						resolveDefault(config, "autoSurfacing", "sessionPersistence"),
					);
					if (selected.length > 0) {
						const content = await injectSurfacedContent(
							activeStore,
							selected,
							autoSurfacing.maxEntryBytes,
							autoSurfacing.maxInjectionBytes,
						);
						if (content) {
							for (const f of selected) injectedFiles.add(f);
							injectedMessage = { customType: "memory-auto-surfacing", content, display: false };
							// spec §14：让用户看见「这一轮想起了什么」。headless 会话不通知。
							if (ctx.hasUI) {
								ctx.ui.notify(`Recalled: ${countInjectedBlocks(content)} entries`, "info");
							}
						}
					}
				}
			} catch {
				/* silently skip auto-surfacing on error */
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus("surfacing", undefined);
			}
		}

		return {
			// 旧 SDK（没有 sections，本地类型就是 0.80.2）的退路：功能不受损，只是缓存变差。
			...(applied ? {} : { systemPrompt: buildInjection(event.systemPrompt, indexSnapshot) }),
			...(injectedMessage ? { message: injectedMessage } : {}),
		};
	});

	// D14：compaction 是**唯一**的会话内刷新点。compaction 已经重写了对话中段，头部再变一次
	// 的边际缓存损失最小，而长会话到这时候往往已经攒下了新记忆（spec §9.1(c) / §10）。
	pi.on("session_compact", async () => {
		const activeStore = store;
		if (!config?.enabled || !activeStore) return;
		// compaction 会把已注入的内容挤出上下文：不清空，这些 entry 本会话再也不会浮现。
		injectedFiles.clear();
		indexSnapshot = await buildIndexSection(
			activeStore,
			config.memIndexInjectMaxLines,
			config.memIndexInjectMaxBytes,
		);
	});

	// spec §10：退出前等在途写操作收尾（上限 lock.timeoutMs），避免留下 stale 锁。
	pi.on("session_shutdown", async () => {
		if (inFlight.size === 0) return;
		// `Promise.race` 胜出后兜底定时器仍然挂在事件循环上（最长 lock.timeoutMs）：宿主从
		// main() 返回后靠事件循环自然 drain 退出，漏一个定时器就把退出拖满超时。显式 clear +
		// unref —— 这条路径必须不留下任何定时器。
		let timer: ReturnType<typeof setTimeout> | undefined;
		const giveUp = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, config?.lock.timeoutMs ?? 5000);
			timer.unref?.();
		});
		try {
			await Promise.race([Promise.allSettled([...inFlight]), giveUp]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		// 先拷到 const：`store` / `memoryDir` 是工厂作用域的 let，在异步回调里 TS 不保留外层收窄。
		const activeStore = store;
		const dir = memoryDir;
		if (!config?.enabled || !dir || !activeStore) return;
		const extractConfig = config.extractMemories;
		if (!extractConfig?.enabled) return;
		if (!event.messages || event.messages.length === 0) return;
		// 本轮经 extract 的工具真实写入了几条（工具的 onWrite 回调计数，spec §14）。
		let written = 0;
		// pi 的 `ExtensionContext` 是代理：`hasUI` / `ui` 的 getter 会先 `runner.assertActive()`，
		// session dispose（/new、switch、fork、reload、退出宽限超时）之后调用即抛错。extract 是
		// 长时后台任务（120s timeout），而 `session_shutdown` 只等 `lock.timeoutMs`（默认 5s），
		// 所以「extract 在途 + session 已销毁」是常态路径：UI 必须在**同步段**快照，回调里不再碰 ctx。
		const ui = ctx.hasUI ? ctx.ui : undefined;
		const extractRun = runExtract({
			agentsMdBlocks: extractAgentsMdBlocks(lastSystemPrompt),
			model: resolveDefault(config, "extractMemories", "model"),
			thinkLevel: extractConfig.thinkLevel,
			memoryDir: dir,
			store: activeStore,
			// **不再**把消息压成 `{role, content}` 字符串（那是提取失真的根因，spec §11.1）：
			// 原样交给 extract，由 toExtractMessages 保留角色 / tool_call / tool_result。
			messages: event.messages,
			maxContextTokens: extractConfig.maxContextTokens,
			maxToolResultChars: extractConfig.maxToolResultChars,
			maxAssistantChars: extractConfig.maxAssistantChars,
			modelRegistry: ctx.modelRegistry,
			parentModel: ctx.model,
			// extract 的工具集与主 agent 相同（5 个 action，D12），且**只**注入它自己的 headless session。
			// 不开 skipSnapshot：extract 没有整轮快照，它的每次写入都该留下自己的回滚点。
			customTools: [
				createMemoryTool(toolDeps, {
					actions: MAIN_AGENT_ACTIONS,
					skipLogicalLock: true,
					onWrite: () => {
						written += 1;
					},
				}),
			],
			sessionPersistence: resolveDefault(config, "extractMemories", "sessionPersistence"),
		});
		track(extractRun);
		// 用两参 `.then`（而不是 `.then().catch()`）：成功通知自己抛错只会进它自己的分支，
		// 不会被失败回调接住 —— 否则会被误报成 `Extract failed:` 并烧掉本 session 的失败配额。
		void extractRun.then(
			(result) => {
				// 只有「没被锁跳过」且「真的写了东西」才报数：否则每轮都弹一条空通知。
				if (result.skipped || written === 0 || !ui) return;
				try {
					ui.notify(`Extracted ${written} ${written === 1 ? "memory" : "memories"}.`, "info");
				} catch {
					// UI 已失效（session dispose 后宿主会忽略这条通知）：不能拖垮进程。
				}
			},
			(e: unknown) => {
				// spec §14：失败不再被静默吞掉，但同一 session 只报一次（extract 每轮都跑，
				// 模型挂了的时候不能把用户淹没在重复通知里）。
				if (extractErrorNotified || !ui) return;
				extractErrorNotified = true;
				try {
					// rejected 的值不一定是 Error（pi 的模型层可能抛字符串 / 对象）。
					ui.notify(`Extract failed: ${e instanceof Error ? e.message : String(e)}`, "error");
				} catch {
					// 配额已经用掉，不再重试。
				}
			},
		);
	});

	pi.registerCommand("memory", {
		description: "Show memory status, toggle enabled, or remove a stale lock",
		handler: async (args, ctx) => {
			if (!config) {
				ctx.ui.notify("Memory not initialized.", "info");
				return;
			}
			if (args === "off" || args === "on") {
				config = { ...config, enabled: args === "on" };
				if (args === "on") {
					// 以 disabled 启动的会话在这里才真正建起 store / 注册工具（见 initMemory）。
					try {
						await initMemory(ctx);
					} catch (e) {
						// Review Focus #1：不得留下「enabled=true 但没有 store」的半状态。
						config = { ...config, enabled: false };
						ctx.ui.notify(`Failed to initialize memory: ${e instanceof Error ? e.message : String(e)}`, "error");
						return;
					}
				}
				// `off` 只翻开关、保留 state：状态命令仍能显示目录与条目数。
				ctx.ui.notify(`Memory ${args}`, "info");
				return;
			}
			if (args === "unlock") {
				// `unlock` 只需要**目录**、不需要 store：以 disabled 启动的会话也要能清锁
				//（它是崩溃遗留 `.lock` 的唯一人工入口，spec §19）。
				await unlockMemory(memoryDir ?? (await resolveMemoryDir(config, ctx.cwd)), ctx.ui);
				return;
			}
			// 先拷到 const：`store` / `memoryDir` 是工厂作用域的 let，异步回调里 TS 不保留外层收窄。
			const activeStore = store;
			const dir = memoryDir;
			if (!dir || !activeStore) {
				// 以 disabled 启动、还没 `/memory on`：报两行而不是一句笼统的 "not initialized" ——
				// 开关状态本身就是诊断信息，第二行直接告诉用户下一步做什么。
				const notReady = [`Memory: ${config.enabled ? "enabled" : "disabled"}`, "Dir: not initialized (run /memory on)"];
				ctx.ui.notify(notReady.join("\n"), "info");
				return;
			}
			// 容量用写入那一侧的口径（memIndexMax*）：用户要知道的是「还能不能写」，
			// 而注入口径（memIndexInject*）默认与它同值（D3）。unrecognized 是索引里非空但
			// 解析不了的行数 —— 手写标题/分组/被 Windows 编辑器改坏的行都在这里露出来。
			const indexRaw = await activeStore.readIndex();
			const cap = indexCapacity(indexRaw, config.memIndexMaxLines, config.memIndexMaxBytes);
			const summary = [
				`Memory: ${config.enabled ? "enabled" : "disabled"}`,
				`Dir: ${dir}`,
				`Index: ${cap.lineCount}/${config.memIndexMaxLines} lines, ${cap.byteLength}/${config.memIndexMaxBytes} bytes, ${parseEntryIndex(indexRaw).unrecognized} unrecognized lines`,
				`Entries: ${(await activeStore.listEntries()).length}`,
				`Last dream: ${(await readDreamMeta(dir))?.lastDreamAt ?? "never"}`,
				`Migration: ${await readMigrationStatus(dir)}`,
				`Lock: ${await lockStatusLine(dir)}`,
			].join("\n");
			ctx.ui.notify(summary, "info");
		},
	});

	pi.registerCommand("dream", {
		description: "Consolidate all memory files via a headless agent",
		handler: async (_args, ctx) => {
			const activeStore = store;
			if (!config || !memoryDir || !activeStore) {
				ctx.ui.notify("Memory not initialized.", "info");
				return;
			}
			// 同步段快照：dream 在途时用户可能 /new、切换、fork、reload。`cwd` 也要快照 ——
			// 完成回调里的 `SessionManager.list` 在 await 之后才读它（见 notifyDream 的说明）。
			const ui = ctx.hasUI ? ctx.ui : undefined;
			const cwd = ctx.cwd;
			const ok = await ctx.ui.confirm("Dream", "Consolidate all memory files? This rewrites them in-place.");
			if (!ok) return;
			const dir = memoryDir;
			ui?.setStatus("dream", "Consolidating memory...");
			const dreamRun = runDream({
				model: resolveDefault(config, "dream", "model"),
				thinkLevel: config.dream.thinkLevel,
				memoryDir,
				store: activeStore,
				maxLines: config.memIndexMaxLines,
				modelRegistry: ctx.modelRegistry,
				parentModel: ctx.model,
				sessionPersistence: resolveDefault(config, "dream", "sessionPersistence"),
				customTools: [
					createMemoryTool(toolDeps, {
						actions: DREAM_ACTIONS,
						skipLogicalLock: true,
						skipSnapshot: true,
					}),
				],
			});
			track(dreamRun);
			void dreamRun
				.then(
					async (summary) => {
						try {
							const sessions = (await SessionManager.list(cwd)).length;
							await writeDreamMeta(dir, sessions);
						} catch (e) {
							notifyDream(ui, dreamFailureMessage(e), "error");
							return;
						}
						notifyDream(ui, summary, "info");
					},
					(e: unknown) => notifyDream(ui, dreamFailureMessage(e), "error"),
				)
				.finally(() => clearDreamStatus(ui));
		},
	});
}
