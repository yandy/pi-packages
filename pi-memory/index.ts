import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type MemoryConfig } from "./src/config";
import { resolveMemoryDir } from "./src/paths";
import { loadIndexSnapshot, buildInjection, scanTopics, injectSurfacedContent, type TopicManifest } from "./src/inject";
import { createMemoryTool } from "./src/memory-tool";
import { searchSessions } from "./src/session-search";
import { runDream } from "./src/dream";
import { runExtract } from "./src/extract";
import { shouldNudge, writeDreamMeta, readDreamMeta } from "./src/nudge";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

function selectRelevantTopics(
	manifest: TopicManifest[],
	userPrompt: string,
	injectedTopics: Set<string>,
	maxFiles: number,
): string[] {
	if (!userPrompt || maxFiles <= 0) return [];
	const words = userPrompt.toLowerCase().split(/\W+/).filter(w => w.length > 2);
	const scored = manifest
		.filter(t => !injectedTopics.has(t.filename))
		.map(t => {
			const desc = t.description.toLowerCase();
			const name = t.name.toLowerCase();
			const score = words.filter(w => desc.includes(w) || name.includes(w)).length;
			return { filename: t.filename, score };
		})
		.filter(t => t.score > 0)
		.sort((a, b) => b.score - a.score);
	return scored.slice(0, maxFiles).map(t => t.filename);
}

export default function (pi: ExtensionAPI) {
	let memoryDir: string | null = null;
	let config: MemoryConfig | null = null;
	let indexSnapshot = "";
	let toolRegistered = false;
	let injectedTopics = new Set<string>();

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
					getConfig: () => config!,
					getEnabled: () => config?.enabled ?? false,
					searchSessions,
					cwd: () => ctx.cwd,
				}) as any,
			);
			toolRegistered = true;
		}

		// nudge
		if (ctx.hasUI) {
			const { nudge, message, sessions } = await shouldNudge(memoryDir, config, ctx.cwd);
			if (nudge) {
				const ok = await ctx.ui.confirm(
					"Memory Consolidation",
					`${message}\n\nConsolidate memory files now?`,
				);
				if (ok) {
					// Fire-and-forget: defers past the current macrotask so all
					// session_start handlers (including pi-subagents') have completed.
					// Does not block session_start.
					const dreamModel = config.dream.model;
					const dir = memoryDir;
					ctx.ui.setStatus("dream", "Consolidating memory...");
					setTimeout(async () => {
						try {
							const summary = await runDream({
								model: dreamModel,
								memoryDir: dir,
								events: pi.events,
							});
							await writeDreamMeta(dir, sessions);
							ctx.ui.notify(summary, "info");
						} catch (e: any) {
							ctx.ui.notify(`Dream failed: ${e.message}`, "error");
						} finally {
							ctx.ui.setStatus("dream", undefined);
						}
					}, 0);
				}
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!config?.enabled || !indexSnapshot || !memoryDir) return;

		let systemPrompt = event.systemPrompt;

		// Auto-surfacing: select relevant topic files and inject their content
		const autoSurfacing = config.autoSurfacing;
		if (autoSurfacing?.enabled && event.prompt) {
			try {
				const manifest = await scanTopics(memoryDir);
				if (manifest.length > 0) {
					const selected = selectRelevantTopics(manifest, event.prompt, injectedTopics, autoSurfacing.maxFiles);
					if (selected.length > 0) {
						const content = await injectSurfacedContent(memoryDir, selected, autoSurfacing.maxTopicBytes, autoSurfacing.maxInjectionBytes);
						if (content) {
							// Track injected topics for session-level dedup
							for (const f of selected) injectedTopics.add(f);
							// Inject surfaced content as a custom message
							systemPrompt += "\n\n" + content;
						}
					}
				}
			} catch { /* silently skip auto-surfacing on error */ }
		}

		// MEMORY.md index injection (always last after auto-surfacing)
		return { systemPrompt: buildInjection(systemPrompt, indexSnapshot) };
	});

	pi.on("agent_end", async (event) => {
		if (!config?.enabled || !memoryDir) return;
		const extractConfig = config.extractMemories;
		if (!extractConfig?.enabled) return;
		if (!event.messages || event.messages.length === 0) return;
		// Fire-and-forget: extract memories in background
		runExtract({
			model: extractConfig.model,
			memoryDir,
			messages: event.messages.map(m => ({
			role: String((m as any).role ?? ""),
			content: typeof (m as any).content === "string"
				? (m as any).content
				: typeof (m as any).output === "string"
					? (m as any).output
					: JSON.stringify((m as any).content ?? ""),
		})),
			maxContextTokens: extractConfig.maxContextTokens,
		}).catch(() => { /* silently ignore extract errors */ });
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
			ctx.ui.setStatus("dream", "Consolidating memory...");
			try {
				const summary = await runDream({
					model: config.dream.model,
					memoryDir,
					signal: ctx.signal,
					events: pi.events,
				});
				const sessions = (await SessionManager.list(ctx.cwd)).length;
				await writeDreamMeta(memoryDir, sessions);
				ctx.ui.notify(summary, "info");
			} catch (e: any) {
				ctx.ui.notify(`Dream failed: ${e.message}`, "error");
			} finally {
				ctx.ui.setStatus("dream", undefined);
			}
		},
	});
}
