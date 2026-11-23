import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CLIENT_RUNTIME } from "./client/runtime";
import type { Lang } from "./model";
import { renderActivity } from "./render/activity";
import { renderBrowser } from "./render/browser";
import { renderCurrentContext } from "./render/context";
import { renderStepDetail } from "./render/detail";
import { renderDocument } from "./render/document";
import { renderEvents } from "./render/events";
import { renderFamily } from "./render/family";
import { renderOverview } from "./render/overview";
import { buildPayload } from "./render/payload";
import { renderTimeline } from "./render/timeline";
import { renderTimingCard } from "./render/timing";
import { renderTokens } from "./render/tokens";
import { buildReport } from "./report";

export interface InsightArgs {
	path?: string;
	mode: "full" | "short";
	lang?: Lang;
}

const USAGE = "usage: /insight [--short] [--lang en|zh] [output.html]";
const HTML_BUDGET_BYTES = 16 * 1024 * 1024;

export function parseInsightArgs(args: string): InsightArgs {
	const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/);
	let mode: "full" | "short" = "full";
	let lang: Lang | undefined;
	let path: string | undefined;
	let shortSeen = false;
	let langSeen = false;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (token === "--short") {
			if (shortSeen) throw new Error(`duplicate --short\n${USAGE}`);
			shortSeen = true;
			mode = "short";
			continue;
		}
		if (token === "--lang") {
			if (langSeen) throw new Error(`duplicate --lang\n${USAGE}`);
			langSeen = true;
			const value = tokens[++index];
			if (value !== "en" && value !== "zh") throw new Error(`--lang expects en or zh\n${USAGE}`);
			lang = value;
			continue;
		}
		if (token.startsWith("-")) throw new Error(`unknown option ${token}; supported: --short, --lang\n${USAGE}`);
		if (path !== undefined) throw new Error(`only one output path is allowed\n${USAGE}`);
		path = token;
	}

	return { mode, ...(lang === undefined ? {} : { lang }), ...(path === undefined ? {} : { path }) };
}

export function langFromEnv(env: Record<string, string | undefined>): Lang | undefined {
	for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const value = env[name];
		if (typeof value === "string" && /^zh/i.test(value)) return "zh";
	}
	return undefined;
}

function filenameStem(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, "_") || "session";
}

export function defaultInsightPath(ctx: ExtensionCommandContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const stem = sessionFile ? basename(sessionFile, ".jsonl") : ctx.sessionManager.getSessionId();
	return join(ctx.cwd, `pi-insight-${filenameStem(stem)}.html`);
}

function hasConversation(ctx: ExtensionCommandContext): boolean {
	return ctx.sessionManager
		.getEntries()
		.some((entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));
}

function bodyOf(report: ReturnType<typeof buildReport>): string {
	return [
		renderOverview(report),
		renderTokens(report),
		renderTimingCard(report),
		renderCurrentContext(report),
		renderTimeline(report),
		renderStepDetail(report),
		renderBrowser(report),
		renderEvents(report),
		renderActivity(report),
		renderFamily(report),
	]
		.filter((part) => part.length > 0)
		.join("\n");
}

export async function runInsight(
	args: string,
	ctx: ExtensionCommandContext,
	options: { generatedAt?: Date; env?: Record<string, string | undefined> } = {},
): Promise<string> {
	await ctx.waitForIdle();
	if (!hasConversation(ctx)) {
		throw new Error("Nothing to report yet - start a conversation first");
	}
	const parsed = parseInsightArgs(args);
	const outputPath = parsed.path === undefined ? defaultInsightPath(ctx) : resolve(ctx.cwd, parsed.path);
	const lang = parsed.lang ?? langFromEnv(options.env ?? process.env) ?? "en";
	const generatedAt = options.generatedAt;
	const build = (bodyScale: number): string => {
		const report = buildReport(ctx, {
			mode: parsed.mode,
			lang,
			bodyScale,
			...(generatedAt === undefined ? {} : { generatedAt }),
		});
		const html = renderDocument({
			report,
			body: bodyOf(report),
			payload: buildPayload(report),
			runtime: CLIENT_RUNTIME,
		});
		return html;
	};
	let html = build(1);
	for (const scale of [0.25, 0]) {
		if (Buffer.byteLength(html, "utf8") <= HTML_BUDGET_BYTES) break;
		html = build(scale);
	}
	await writeFile(outputPath, html, "utf8");
	return outputPath;
}

export function registerInsightCommand(pi: ExtensionAPI): void {
	pi.registerCommand("insight", {
		description: "Generate an offline HTML insight report for this session (--short omits raw content)",
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
