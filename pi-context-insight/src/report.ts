import type { ContextUsage, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { analyzeActivity, analyzeTiming } from "./activity";
import { analyzeContextProjection } from "./context";
import { extractContextEvents } from "./events";
import type { InsightReport, ReadonlySessionManager, SessionReport } from "./model";
import { loadSubagentSessions } from "./subagents";
import { collectUsageLedger, summarizeUsage } from "./usage";

function latestPhysicalModel(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
	}
	return undefined;
}

export function analyzeSessionManager(
	manager: ReadonlySessionManager,
	options: {
		cwd: string;
		model?: string;
		thinkingLevel?: string;
		contextUsage?: ContextUsage;
		fallbackSystemPrompt?: string;
	},
): SessionReport {
	const entries = manager.getEntries();
	const projection = manager.buildSessionProjection();
	const usage = summarizeUsage(collectUsageLedger(entries));
	const activity = analyzeActivity(entries);
	const context = analyzeContextProjection(projection, {
		...(options.contextUsage === undefined ? {} : { usage: options.contextUsage }),
		...(options.fallbackSystemPrompt === undefined ? {} : { fallbackSystemPrompt: options.fallbackSystemPrompt }),
	});
	const model =
		options.model ??
		(projection.model ? `${projection.model.provider}/${projection.model.modelId}` : undefined) ??
		latestPhysicalModel(manager.getBranch());
	return {
		metadata: {
			id: manager.getSessionId(),
			...(manager.getSessionName() === undefined ? {} : { name: manager.getSessionName() }),
			cwd: options.cwd,
			...(manager.getSessionFile() === undefined ? {} : { filePath: manager.getSessionFile() }),
			...(model === undefined ? {} : { model }),
			thinkingLevel: options.thinkingLevel ?? projection.thinkingLevel,
		},
		usage,
		context,
		activity,
		events: extractContextEvents(entries),
		timing: analyzeTiming(entries, activity.executions),
		warnings: [...usage.warnings, ...context.warnings],
	};
}

export function buildInsightReport(
	ctx: ExtensionCommandContext,
	options: { generatedAt?: Date; loadChildren?: typeof loadSubagentSessions } = {},
): InsightReport {
	const parent = analyzeSessionManager(ctx.sessionManager, {
		cwd: ctx.cwd,
		...(ctx.model === undefined ? {} : { model: `${ctx.model.provider}/${ctx.model.id}` }),
		...(ctx.thinkingLevel === undefined ? {} : { thinkingLevel: ctx.thinkingLevel }),
		contextUsage: ctx.getContextUsage(),
		fallbackSystemPrompt: ctx.getSystemPrompt(),
	});
	const loadChildren = options.loadChildren ?? loadSubagentSessions;
	const children = loadChildren(ctx.sessionManager);
	const subagents = children.sessions.map((child) => ({
		agent: child.metadata,
		report: analyzeSessionManager(child.manager, {
			cwd: child.manager.getCwd(),
			...(child.metadata.modelName === undefined ? {} : { model: child.metadata.modelName }),
			...(child.metadata.thinking === undefined ? {} : { thinkingLevel: child.metadata.thinking }),
		}),
	}));
	const warnings = [...parent.warnings, ...children.warnings.map((warning) => `Subagent discovery: ${warning}`)];
	for (const child of subagents) {
		warnings.push(...child.report.warnings.map((warning) => `Subagent ${child.agent.id}: ${warning}`));
	}
	return {
		...parent,
		generatedAt: (options.generatedAt ?? new Date()).toISOString(),
		subagents,
		warnings,
	};
}
