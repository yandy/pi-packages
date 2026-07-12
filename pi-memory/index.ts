import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type MemoryConfig } from "./src/config";
import { resolveMemoryDir } from "./src/paths";
import { loadIndexSnapshot, buildInjection } from "./src/inject";
import { createMemoryTool } from "./src/memory-tool";
import { searchSessions } from "./src/session-search";
import { runDream } from "./src/dream";
import { shouldNudge, writeDreamMeta, readDreamMeta } from "./src/nudge";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
	let memoryDir: string | null = null;
	let config: MemoryConfig | null = null;
	let indexSnapshot = "";
	let toolRegistered = false;

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
					ctx.ui.setStatus("dream", "Consolidating memory...");
					try {
						const summary = await runDream({
							model: config.dream.model,
							memoryDir,
							events: pi.events,
						});
						await writeDreamMeta(memoryDir, sessions);
						ctx.ui.notify(summary, "info");
					} catch (e: any) {
						ctx.ui.notify(`Dream failed: ${e.message}`, "error");
					} finally {
						ctx.ui.setStatus("dream", undefined);
					}
				}
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!config?.enabled || !indexSnapshot) return;
		return { systemPrompt: buildInjection(event.systemPrompt, indexSnapshot) };
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
