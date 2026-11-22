import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { renderInsightHtml } from "./html";
import { buildInsightReport } from "./report";

function filenameStem(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, "_") || "session";
}

export function defaultInsightPath(ctx: ExtensionCommandContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const stem = sessionFile ? basename(sessionFile, ".jsonl") : ctx.sessionManager.getSessionId();
	return join(ctx.cwd, `pi-insight-${filenameStem(stem)}.html`);
}

export async function runInsight(
	args: string,
	ctx: ExtensionCommandContext,
	options: { generatedAt?: Date } = {},
): Promise<string> {
	await ctx.waitForIdle();
	const customPath = args.trim();
	const outputPath = customPath ? resolve(ctx.cwd, customPath) : defaultInsightPath(ctx);
	const report = buildInsightReport(ctx, options);
	await writeFile(outputPath, renderInsightHtml(report), "utf8");
	return outputPath;
}

export function registerInsightCommand(pi: ExtensionAPI): void {
	pi.registerCommand("insight", {
		description: "Generate an offline HTML insight report for this session",
		handler: async (args, ctx) => {
			try {
				const outputPath = await runInsight(args, ctx);
				ctx.ui.notify(`Insight written to: ${outputPath}`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to generate insight: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
