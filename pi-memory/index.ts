import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig, modelConfigErrors, requiredModel, type MemoryConfig, type SessionPersistenceConfig } from "./src/config";
import { runDream } from "./src/dream";
import { indexCapacity, parseEntryIndex } from "./src/entry-index";
import { runExtract } from "./src/extract";
import { readLockStatus, type LockInfo } from "./src/fs-lock";
import { readRecordedMemoryIndex } from "./src/index-source";
import { applyIndexSection, buildIndexSection, buildInjection, injectSurfacedContent, runSideQuery, scanEntries } from "./src/inject";
import {
	createMemoryTool,
	DREAM_ACTIONS,
	MAIN_AGENT_ACTIONS,
	type MemoryToolDeps,
} from "./src/memory-tool";
import { LOCK_FILE, MemoryStore } from "./src/memory-store";
import { resolveModel } from "./src/model-resolver";
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

/** `<op> (pid N on <hostname>, started <ISO>)` —— `/memory` 的 Lock 行与 unlock 确认框共用同一份描述。 */
function describeHolder(holder: LockInfo): string {
	return `${holder.op} (pid ${holder.pid} on ${holder.hostname}, started ${holder.startedAt})`;
}

/**
 * `/memory` 的锁状态行。只读不碰 —— `.lock` **永不自动回收**（spec §5.1），
 * 人工清除只有 `/memory unlock` 一个入口。
 * 带 hostname：`.lock` 是目录里的普通文件，同一份目录可能被挂载到多台机器（spec §19），
 * 只看 pid 无法判断持有者是不是“本机的另一个进程”。
 */
async function lockStatusLine(memoryDir: string): Promise<string> {
	const status = await readLockStatus(join(memoryDir, LOCK_FILE));
	if (status.kind === "absent") return "free";
	if (status.kind === "unreadable") return "unreadable — run /memory unlock";
	return `held by ${describeHolder(status.holder)}`;
}

/**
 * `/memory unlock`：崩溃遗留的 `.lock` 的**唯一**人工清除入口（spec §19 风险表）。
 * 必须显式 confirm，而且只删 `.lock` 本身 —— 删错了就是两个写入者同时持有锁。
 * confirm 正文在 `held` 时点名持有者：只有人能把「本机已死的进程」与「别的机器正在跑」区分开。
 */
async function unlockMemory(memoryDir: string, ui: ExtensionUIContext): Promise<void> {
	const lockPath = join(memoryDir, LOCK_FILE);
	const status = await readLockStatus(lockPath);
	if (status.kind === "absent") {
		ui.notify("No lock present.", "info");
		return;
	}
	const question =
		status.kind === "held"
			? `Remove the memory lock file? It is held by ${describeHolder(status.holder)}. Only do this if no memory operation is running.`
			: "Remove the memory lock file? Only do this if no memory operation is running.";
	const ok = await ui.confirm("Memory lock", question);
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

function resolveDefault(cfg: MemoryConfig, task: "dream" | "autoSurfacing" | "extractMemories", key: "sessionPersistence"): SessionPersistenceConfig | undefined {
	const perTask = cfg[task][key];
	if (perTask !== undefined) return perTask;
	return cfg.defaults?.[key];
}

export default function (pi: ExtensionAPI) {
	let memoryDir: string | null = null;
	let config: MemoryConfig | null = null;
	/** 唯一写入通道（D4）。session_start 里建，之后工具 / extract / dream 都只经它读写。 */
	let store: MemoryStore | null = null;
	/** 配置错误态（模型校验失败或初始化失败）。/memory 重复显示它，直到用户改好配置并重启。 */
	let configError: string | null = null;
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

	/** `enabled: false` 时给用户的唯一动作。工具文案与 `/memory` 状态共用同一份，避免两处漂移。 */
	const ENABLE_HINT = 'set "enabled": true in memory.json and restart';

	/**
	 * 清空本 session 的运行时状态。三条早退路径（disabled / 配置错误 / 初始化失败）共用：
	 * 残留上一 session 的 store 会让后续写入落到别的项目目录（Plan C ledger R51）。
	 */
	function resetSessionState(): void {
		memoryDir = null;
		store = null;
		indexSnapshot = "";
		injectedFiles.clear();
	}

	/** 统一的配置错误态：记录 → 清空运行时 → 通知。无 UI 时只记录（`/memory` 仍可读到）。 */
	function failConfig(errors: string[], ctx: ExtensionContext): void {
		configError = errors.join("\n");
		resetSessionState();
		if (!ctx.hasUI) return;
		ctx.ui.notify(`pi-memory config error:\n${errors.map((e) => `- ${e}`).join("\n")}`, "error");
	}

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
		getUnavailableMessage: () =>
			configError
				? `Memory not initialized — ${configError.split("\n")[0]}; run /memory for details`
				: config?.enabled === false
					? `Memory is disabled — ${ENABLE_HINT}`
					: null,
		searchSessions,
		cwd: () => currentCwd,
	};

	/**
	 * 建立本 session 的记忆运行时：目录 → store → 索引来源 → 注册工具。
	 *
	 * 只在 `session_start` 调用，且调用方已确认 `config.enabled`（中途启用路径已随 `/memory on` 删除）。
	 * 抛错 = 初始化失败，由调用方转成配置错误态（`configError`）。
	 * `reason` 只有 `session_start` 会传：resume / fork / reload 用 transcript 的录制值（D14）。
	 */
	async function initMemory(ctx: ExtensionContext, reason?: string): Promise<void> {
		// biome-ignore lint/style/noNonNullAssertion: 调用方已确认 enabled
		const cfg = config!;
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

		// D13 / D14：索引值在整个 session 内**冻结**。resume / fork / reload 必须用 transcript 里的
		// 录制值 —— 否则被恢复会话的 system prompt 头部会被改写，而 memory_index 是头部的最后一段，
		// 折叠路径下其后的整段对话全部失去缓存。录制值拿不到（更老的 session、旧 SDK 没有
		// sessionEntryToContextMessages）才回退磁盘读。
		// 录制值**不再 re-sanitize**：写入当年已经净化过，而 sanitizeForInjection 是幂等的 ——
		// 保持字节恒等更利于缓存。
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
	}
	pi.on("session_start", async (event, ctx) => {
		// 复位必须在**任何可能抛错的调用之前**跑完：冷启动与 disabled 会话都要有干净的一次失败通知
		// 配额、干净的错误态，以及**清空的运行时**。loadConfig（里面的 getAgentDir）与下面的
		// modelConfigErrors（宿主给的 registry 可能既没有 getAvailable 也没有 getAll）都属于宿主契约
		// 之外的部分：它们一旦抛出而复位还没跑，上一 session 的 store / memoryDir 就会留在**已经注册**
		// 的 `memory` 工具背后 —— 项目 B 的 agent 能写进项目 A 的目录（Plan C ledger R51）。
		extractErrorNotified = false;
		configError = null;
		resetSessionState();
		// `loadConfig` 抛错（`getAgentDir` / `isProjectTrusted` 属宿主契约）与初始化失败同一处理：
		// 转成配置错误态，不把裸 reject 冒给宿主（spec §2.4）。用局部变量承接是为了让后面的收窄
		// 不受 `config` 这个工厂作用域 let 影响。（nudge 块仍可能抛错，属既有暴露面，不在本次范围。）
		let loaded: MemoryConfig;
		try {
			loaded = await loadConfig(ctx);
		} catch (e) {
			failConfig([`Failed to load memory config: ${e instanceof Error ? e.message : String(e)}`], ctx);
			return;
		}
		config = loaded;
		// 状态已经干净，disabled 直接早退即可。
		if (!loaded.enabled) return;
		try {
			// 启动校验（spec §2.3）：模型键缺失 / 不可解析 → 本会话**完全不初始化**
			//（不解析目录、不建 store、不注册工具），错误态由 `/memory` 重复显示。
			// 校验本身抛错（registry 不合契约）也走同一个 catch：failConfig 自己会复位运行时。
			const errors = modelConfigErrors(loaded, (value) => resolveModel(value, ctx.modelRegistry) !== undefined);
			if (errors.length > 0) {
				failConfig(errors, ctx);
				return;
			}
			await initMemory(ctx, (event as { reason?: string }).reason);
		} catch (e) {
			// spec §2.4：初始化失败走同一个错误态，不冒泡给宿主（那只会变成一条裸报错）。
			failConfig([`Failed to initialize memory: ${e instanceof Error ? e.message : String(e)}`], ctx);
			return;
		}

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
					const dreamModel = requiredModel(config, "dream");
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
						requiredModel(config, "autoSurfacing"),
						ctx.modelRegistry,
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
		// 守卫之后立刻取值：requiredModel 抛错必须发生在这里（agent_end 直接失败），而不是在
		// runExtract({...}) 的字面量求值中途 —— 那时 track / .then 的收尾链已经无从挂上。
		const extractModel = requiredModel(config, "extractMemories");
		// 本轮经 extract 的工具真实写入了几条（工具的 onWrite 回调计数，spec §14）。
		let written = 0;
		// pi 的 `ExtensionContext` 是代理：`hasUI` / `ui` 的 getter 会先 `runner.assertActive()`，
		// session dispose（/new、switch、fork、reload、退出宽限超时）之后调用即抛错。extract 是
		// 长时后台任务（120s timeout），而 `session_shutdown` 只等 `lock.timeoutMs`（默认 5s），
		// 所以「extract 在途 + session 已销毁」是常态路径：UI 必须在**同步段**快照，回调里不再碰 ctx。
		const ui = ctx.hasUI ? ctx.ui : undefined;
		const extractRun = runExtract({
			agentsMdBlocks: extractAgentsMdBlocks(lastSystemPrompt),
			model: extractModel,
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
		description: "Show memory status or remove a stale lock",
		handler: async (args, ctx) => {
			// 配置都读不出来（`loadConfig` 抛错）时也要报真实原因，而不是笼统的「未初始化」——
			// `/memory` 是重读错误态的唯一入口。首次会话就失败时 `config` 仍是 null，所以这里先看错误态。
			if (!config) {
				if (configError) {
					ctx.ui.notify(
						["Memory: misconfigured", "Dir: not initialized", ...configError.split("\n").map((e) => `- ${e}`)].join("\n"),
						"info",
					);
					return;
				}
				ctx.ui.notify("Memory not initialized.", "info");
				return;
			}
			if (args === "unlock") {
				// `unlock` 只需要**目录**、不需要 store：以 disabled 启动的会话也要能清锁
				//（它是崩溃遗留 `.lock` 的唯一人工入口，spec §19）。
				let dir = memoryDir;
				if (!dir) {
					// 目录解析本身可能失败（HOME 不可写 / git 探测炸了）：失败要变成一条可读的 error
					// 通知，不能冒泡成命令 handler 抛错（那只会变成一条裸的宿主报错）。
					try {
						dir = await resolveMemoryDir(config, ctx.cwd);
					} catch (e) {
						ctx.ui.notify(
							`Failed to resolve memory dir: ${e instanceof Error ? e.message : String(e)}`,
							"error",
						);
						return;
					}
				}
				await unlockMemory(dir, ctx.ui);
				return;
			}
			// 先拷到 const：`store` / `memoryDir` 是工厂作用域的 let，异步回调里 TS 不保留外层收窄。
			const activeStore = store;
			const dir = memoryDir;
			if (!dir || !activeStore) {
				// configError 非空 = 校验或初始化失败（`/memory` 是用户重读错误的唯一入口）；
				// 否则只可能是配置里 enabled 为假。
				const lines = configError
					? ["Memory: misconfigured", "Dir: not initialized", ...configError.split("\n").map((e) => `- ${e}`)]
					: ["Memory: disabled", `Dir: not initialized — ${ENABLE_HINT}`];
				ctx.ui.notify(lines.join("\n"), "info");
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
			// 先取模型再改状态：requiredModel 抛错时不能把 "dream" 状态留在那儿（这条链没有 .finally）。
			const dreamModel = requiredModel(config, "dream");
			ui?.setStatus("dream", "Consolidating memory...");
			const dreamRun = runDream({
				model: dreamModel,
				thinkLevel: config.dream.thinkLevel,
				memoryDir,
				store: activeStore,
				maxLines: config.memIndexMaxLines,
				modelRegistry: ctx.modelRegistry,
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
