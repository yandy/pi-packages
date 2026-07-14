import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig, type MemoryConfig } from "./src/config";
import { runDream } from "./src/dream";
import { runExtract } from "./src/extract";
import {
	buildInjection,
	injectSurfacedContent,
	loadIndexSnapshot,
	runSideQuery,
	scanTopics,
} from "./src/inject";
import { createMemoryTool } from "./src/memory-tool";
import { readDreamMeta, shouldNudge, writeDreamMeta } from "./src/nudge";
import { resolveMemoryDir } from "./src/paths";
import { searchSessions } from "./src/session-search";

export default function (pi: ExtensionAPI) {
	let memoryDir: string | null = null;
	let config: MemoryConfig | null = null;
	let indexSnapshot = "";
	let toolRegistered = false;
	const injectedTopics = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig(ctx);
		if (!config.enabled) return;
		memoryDir = await resolveMemoryDir(config, ctx.cwd);
		indexSnapshot = await loadIndexSnapshot(memoryDir, config.memIndexMaxLines, config.memIndexMaxBytes);

		// register memory tool once
		if (!toolRegistered) {
			pi.registerTool(
				createMemoryTool({
					getMemoryDir: () => memoryDir,
					// biome-ignore lint/style/noNonNullAssertion: config assigned in guard above
					getConfig: () => config!,
					getEnabled: () => config?.enabled ?? false,
					searchSessions,
					cwd: () => ctx.cwd,
					// biome-ignore lint/suspicious/noExplicitAny: pi registerTool type cast
				}) as any,
			);
			toolRegistered = true;
		}

		// nudge
		if (ctx.hasUI) {
			const { nudge, message, sessions } = await shouldNudge(memoryDir, config, ctx.cwd);
			if (nudge) {
				const ok = await ctx.ui.confirm("Memory Consolidation", `${message}\n\nConsolidate memory files now?`);
				if (ok) {
					// Fire-and-forget: does not block session_start. The headless
					// dream agent runs independently; completion notifies the user.
					const dreamModel = config.dream.model;
					const dreamThinkLevel = config.dream.thinkLevel;
					const dir = memoryDir;
					ctx.ui.setStatus("dream", "Consolidating memory...");
					runDream({
						model: dreamModel,
						thinkLevel: dreamThinkLevel,
						memoryDir: dir,
						modelRegistry: ctx.modelRegistry,
						parentModel: ctx.model,
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
		if (!config?.enabled || !indexSnapshot || !memoryDir) return;

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
				const manifest = await scanTopics(memoryDir);
				if (manifest.length > 0) {
					const selected = await runSideQuery(
						manifest,
						event.prompt.slice(0, 4000),
						injectedTopics,
						autoSurfacing.maxFiles,
						autoSurfacing.thinkLevel,
						autoSurfacing.model,
						ctx.modelRegistry,
						ctx.model,
						memoryDir,
					);
					if (selected.length > 0) {
						const content = await injectSurfacedContent(
							memoryDir,
							selected,
							autoSurfacing.maxTopicBytes,
							autoSurfacing.maxInjectionBytes,
						);
						if (content) {
							for (const f of selected) injectedTopics.add(f);
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
		if (!config?.enabled || !memoryDir) return;
		const extractConfig = config.extractMemories;
		if (!extractConfig?.enabled) return;
		if (!event.messages || event.messages.length === 0) return;
		runExtract({
			model: extractConfig.model,
			thinkLevel: extractConfig.thinkLevel,
			memoryDir,
			modelRegistry: ctx.modelRegistry,
			parentModel: ctx.model,
			messages: event.messages.map((m) => ({
				// biome-ignore lint/suspicious/noExplicitAny: pi event message union type
				role: String((m as any).role ?? ""),
				content:
					// biome-ignore lint/suspicious/noExplicitAny: pi event message union type
					typeof (m as any).content === "string"
						? // biome-ignore lint/suspicious/noExplicitAny: pi event message union type
							(m as any).content
						: // biome-ignore lint/suspicious/noExplicitAny: pi event message union type
							typeof (m as any).output === "string"
							? // biome-ignore lint/suspicious/noExplicitAny: pi event message union type
								(m as any).output
							: // biome-ignore lint/suspicious/noExplicitAny: pi event message union type
								JSON.stringify((m as any).content ?? ""),
			})),
			maxContextTokens: extractConfig.maxContextTokens,
		}).catch(() => {
			/* silently ignore extract errors */
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
			if (!config || !memoryDir) {
				ctx.ui.notify("Memory not initialized.", "info");
				return;
			}
			const ok = await ctx.ui.confirm("Dream", "Consolidate all memory files? This rewrites them in-place.");
			if (!ok) return;
			const dir = memoryDir;
			ctx.ui.setStatus("dream", "Consolidating memory...");
			runDream({
				model: config.dream.model,
				thinkLevel: config.dream.thinkLevel,
				memoryDir,
				modelRegistry: ctx.modelRegistry,
				parentModel: ctx.model,
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
