import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig, type MemoryConfig, type SessionPersistenceConfig } from "./src/config";
import { runDream } from "./src/dream";
import { runExtract } from "./src/extract";
import { buildInjection, injectSurfacedContent, loadIndexSnapshot, runSideQuery, scanEntries } from "./src/inject";
import {
	createMemoryTool,
	DREAM_ACTIONS,
	MAIN_AGENT_ACTIONS,
	type MemoryToolDeps,
} from "./src/memory-tool";
import { MemoryStore } from "./src/memory-store";
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
	/** 本 session 已注入过的 entry **文件名**（spec §9.3）。session_compact 会清空它 —— Plan C。 */
	const injectedFiles = new Set<string>();
	let lastSystemPrompt = "";

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

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig(ctx);
		if (!config.enabled) return;
		currentCwd = ctx.cwd;
		memoryDir = await resolveMemoryDir(config, ctx.cwd);
		store = new MemoryStore({
			memoryDir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
		indexSnapshot = await loadIndexSnapshot(memoryDir, config.memIndexInjectMaxLines, config.memIndexInjectMaxBytes);

		// register memory tool once
		if (!toolRegistered) {
			pi.registerTool(
				// biome-ignore lint/suspicious/noExplicitAny: pi registerTool type cast
				createMemoryTool(toolDeps) as any,
			);
			toolRegistered = true;
		}

		// nudge
		if (ctx.hasUI) {
			const { nudge, message, sessions } = await shouldNudge(memoryDir, config, ctx.cwd);
			if (nudge) {
				const ok = await ctx.ui.confirm("Memory Consolidation", `${message}\n\nConsolidate memory files now?`);
				// dream 需要 store（整轮逻辑锁 + 快照都挂在它上面）；这里必然非空，但 const 拷贝让 TS 也能看到。
				const activeStore = store;
				if (ok && activeStore) {
					// Fire-and-forget: does not block session_start. The headless
					// dream agent runs independently; completion notifies the user.
					const dreamModel = resolveDefault(config, "dream", "model");
					const dreamThinkLevel = config.dream.thinkLevel;
					const dir = memoryDir;
					ctx.ui.setStatus("dream", "Consolidating memory...");
					runDream({
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
					})
						.then(async (summary) => {
							await writeDreamMeta(dir, sessions);
							ctx.ui.notify(summary, "info");
						})
						// biome-ignore lint/suspicious/noExplicitAny: error catch
						.catch((e: any) => {
							ctx.ui.notify(`Dream failed: ${e.message}`, "error");
						})
						.finally(() => {
							ctx.ui.setStatus("dream", undefined);
						});
				}
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		lastSystemPrompt = event.systemPrompt;
		// 先拷到 const：`store` 是工厂作用域的 let，在异步回调里 TS 不会保留它的外层收窄。
		const activeStore = store;
		if (!config?.enabled || !indexSnapshot || !memoryDir || !activeStore) return;

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
						}
					}
				}
			} catch {
				/* silently skip auto-surfacing on error */
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus("surfacing", undefined);
			}
		}

		// MEMORY.md index injection (always last after auto-surfacing)
		return {
			systemPrompt: buildInjection(event.systemPrompt, indexSnapshot),
			...(injectedMessage ? { message: injectedMessage } : {}),
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		// 先拷到 const：`store` / `memoryDir` 是工厂作用域的 let，在异步回调里 TS 不保留外层收窄。
		const activeStore = store;
		const dir = memoryDir;
		if (!config?.enabled || !dir || !activeStore) return;
		const extractConfig = config.extractMemories;
		if (!extractConfig?.enabled) return;
		if (!event.messages || event.messages.length === 0) return;
		void runExtract({
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
			customTools: [createMemoryTool(toolDeps, { actions: MAIN_AGENT_ACTIONS, skipLogicalLock: true })],
			sessionPersistence: resolveDefault(config, "extractMemories", "sessionPersistence"),
		}).catch(() => {
			// Plan C 会把这里换成限流的用户可见通知（spec §14：「extract 失败 → 通知错误」）。
			// Plan B 先保持静默：runExtract 自己已经不再吞错，这里只是避免未处理的 rejection 撕下整个进程。
		});
	});

	pi.registerCommand("memory", {
		description: "Show memory status, toggle enabled, or open files",
		handler: async (args, ctx) => {
			if (!config || !memoryDir) {
				ctx.ui.notify("Memory not initialized.", "info");
				return;
			}
			if (args === "off" || args === "on") {
				config = { ...config, enabled: args === "on" };
				ctx.ui.notify(`Memory ${args}`, "info");
				return;
			}
			const files = (await readdir(memoryDir).catch(() => [])).filter((f) => f.endsWith(".md"));
			const indexRaw = await readFile(join(memoryDir, "MEMORY.md"), "utf8").catch(() => "");
			const lineCount = indexRaw ? indexRaw.split("\n").filter(Boolean).length : 0;
			const meta = await readDreamMeta(memoryDir);
			const summary = [
				`Memory: ${config.enabled ? "enabled" : "disabled"}`,
				`Dir: ${memoryDir}`,
				`Index: ${lineCount}/${config.memIndexMaxLines} lines`,
				`Topic files: ${files.filter((f) => f !== "MEMORY.md").join(", ") || "none"}`,
				`Last dream: ${meta?.lastDreamAt ?? "never"}`,
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
			const ok = await ctx.ui.confirm("Dream", "Consolidate all memory files? This rewrites them in-place.");
			if (!ok) return;
			const dir = memoryDir;
			ctx.ui.setStatus("dream", "Consolidating memory...");
			runDream({
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
			})
				.then(async (summary) => {
					const sessions = (await SessionManager.list(ctx.cwd)).length;
					await writeDreamMeta(dir, sessions);
					ctx.ui.notify(summary, "info");
				})
				// biome-ignore lint/suspicious/noExplicitAny: command handler ctx
				.catch((e: any) => {
					ctx.ui.notify(`Dream failed: ${e.message}`, "error");
				})
				.finally(() => {
					ctx.ui.setStatus("dream", undefined);
				});
		},
	});
}
