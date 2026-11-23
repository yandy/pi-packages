import { basename } from "node:path";
import type { ExtensionCommandContext, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";

/** The host action surface exists at runtime but is not on the public command-context type. */
interface HostActions {
	getAllTools?: () => ToolInfo[];
	getSettings?: () => { compaction?: { enabled?: boolean; reserveTokens?: number } };
}

import { SessionManager as SessionManagerClass } from "@earendil-works/pi-coding-agent";
import { type CommandReport, collectCommands } from "./activity/commands";
import { aggregateFiles, collectFileOps, type FileRow, type FileSort } from "./activity/files";
import { aggregateTools, collectToolExecutions, type ToolRow } from "./activity/tools";
import { collectFamily, type FamilyMember, type SubagentRecord, sortFamily } from "./family";
import type { ReadonlySessionManager, ReportMetadata, TruncationEntry, UsageReport } from "./model";
import { CATEGORY_ORDER, type CategoryId, type CurrentContext, type Kpis, type Lang, type Msg } from "./model";
import type { Item } from "./session/categorize";
import { buildMilestones, collectEvents, type InsightEvent, type Milestone } from "./session/events";
import { applyDetailWindow, buildSteps, type Step, type Turn } from "./session/steps";
import { computeTiming, type TimingReport } from "./session/timing";
import { allocateCost, collectUsageLedger, summarizeUsage } from "./session/usage";

export interface UsageRow {
	entryId: string;
	timestamp: string;
	source: string;
	provider?: string;
	model?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface SessionReport {
	schema: 2;
	mode: "full" | "short";
	lang: Lang;
	metadata: ReportMetadata;
	kpis: Kpis;
	usage: UsageReport;
	usageRows: UsageRow[];
	steps: Step[];
	turns: Turn[];
	items: Item[];
	bodies: string[];
	events: InsightEvent[];
	milestones: Milestone[];
	peaks: { longest?: number; growth?: number };
	currentContext: CurrentContext;
	timing: TimingReport;
	tools: ToolRow[];
	files: FileRow[];
	commands: CommandReport;
	warnings: Msg[];
	truncation: TruncationEntry[];
}

export interface InsightReport extends SessionReport {
	generatedAt: string;
	family: { members: FamilyMember[]; children: Array<{ member: FamilyMember; report: InsightReport }> };
}

const DEFAULT_RESERVE_TOKENS = 16_384;
const USAGE_ROW_LIMIT = 200;
const BODY_CAPS: Partial<Record<CategoryId, number>> = {
	toolResults: 4000,
	toolCalls: 2000,
	answers: 8000,
	reasoning: 8000,
};

export interface SessionInput {
	manager: ReadonlySessionManager;
	cwd: string;
	mode: "full" | "short";
	lang: Lang;
	bodyScale?: number;
	detailSteps?: number;
	model?: string;
	thinkingLevel?: string;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
	toolInfos?: readonly ToolInfo[];
	window: number;
	maxTokens: number;
	reserveTokens: number;
	reserveEnabled: boolean;
	family?: InsightReport["family"];
}

function applyBodyCaps(items: readonly Item[], bodies: string[], truncation: TruncationEntry[], scale = 1): void {
	const buckets = new Map<string, Map<number, number>>();
	for (const item of items) {
		if (item.textIndex === null) continue;
		const cap = Math.max(200, Math.round((BODY_CAPS[item.category] ?? 8000) * scale));
		const text = bodies[item.textIndex];
		if (text === undefined || text.length <= cap) continue;
		bodies[item.textIndex] = text.slice(0, cap);
		item.truncated = true;
		let bucket = buckets.get(item.category);
		if (bucket === undefined) {
			bucket = new Map<number, number>();
			buckets.set(item.category, bucket);
		}
		bucket.set(item.textIndex, text.length);
	}
	for (const [category, bucket] of buckets) {
		truncation.push({ kind: "body", limit: BODY_CAPS[category as CategoryId] ?? 8000, actual: bucket.size });
	}
}

function emptySums(): Record<CategoryId, number> {
	const sums = {} as Record<CategoryId, number>;
	for (const id of CATEGORY_ORDER) sums[id] = 0;
	return sums;
}

function currentContextOf(input: {
	usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	steps: readonly Step[];
	finalEstimate: number;
	finalSums: Record<CategoryId, number>;
	window: number;
	reserveTokens: number;
	reserveEnabled: boolean;
	maxTokens: number;
}): CurrentContext {
	// The active state after the last entry is what the next request will carry.
	const categories = emptySums();
	for (const id of CATEGORY_ORDER) categories[id] = input.finalSums[id] ?? 0;
	const last = input.steps.at(-1);

	let tokens: number | null = input.usage?.tokens ?? null;
	let estimated = false;
	if (tokens === null) {
		const base = last?.actual?.prompt ?? last?.estimatedTotal ?? 0;
		tokens = Math.max(0, base + (input.finalEstimate - (last?.estimatedTotal ?? 0)));
		estimated = true;
	}
	const window = input.usage?.contextWindow ?? input.window;
	const percent = window > 0 && tokens !== null ? Math.round((tokens / window) * 1000) / 10 : null;
	return {
		tokens,
		estimated,
		window,
		percent,
		categories,
		reserveTokens: input.reserveTokens,
		reserveEnabled: input.reserveEnabled,
		maxTokens: input.maxTokens,
		unknownSystem: (input.steps.at(-1)?.system ?? null) === null,
	};
}

function kpisOf(args: {
	usage: UsageReport;
	timing: TimingReport;
	steps: readonly Step[];
	turns: readonly Turn[];
	toolRows: readonly ToolRow[];
	members: readonly FamilyMember[];
}): Kpis {
	const { usage, timing, steps, turns, toolRows, members } = args;
	return {
		tokens: usage.total.total,
		prompt: usage.total.prompt,
		output: usage.total.output,
		cost: usage.total.cost,
		costBasis: usage.total.costBasis,
		cacheHitRate: usage.total.cacheHitRate,
		modelCalls: steps.length,
		turns: turns.length,
		toolCalls: toolRows.reduce((sum, row) => sum + row.calls, 0),
		activeMs: timing.activeMs,
		modelMs: timing.modelMs,
		toolMs: timing.toolMs,
		subagents: members.length,
		forwardedPrompt: usage.forwardedSubagents.prompt,
		forwardedCost: usage.forwardedSubagents.cost,
	};
}

/** Build everything a single session contributes, independent of how it was loaded. */
export function buildSessionReport(input: SessionInput): SessionReport {
	const entries = input.manager.getEntries();
	const branch = input.manager.getBranch();
	const warnings: Msg[] = [];
	const truncation: TruncationEntry[] = [];

	const { steps, items, bodies, turns, finalEstimate, finalSums, stepItemIds } = buildSteps({
		branch,
		mode: input.mode,
		putBody: () => null,
	});
	allocateCost(steps);

	const ledger = collectUsageLedger(entries);
	const usage = summarizeUsage(ledger);
	for (const warning of ledger.warnings) warnings.push({ key: "warning.usageMalformed", params: { detail: warning } });

	const executions = collectToolExecutions({ entries, steps });
	const timing = computeTiming({
		entries: branch,
		steps,
		executions: executions.map((execution) => ({
			name: execution.name,
			nested: execution.nested,
			...(execution.durationMs === undefined ? {} : { durationMs: execution.durationMs }),
			durationEstimated: execution.durationEstimated,
		})),
	});

	const records = parseSubagentRecords(entries);

	const events = collectEvents({
		entries,
		steps,
		subagentRecords: (input.mode === "short" ? records.map((record) => ({ ...record, description: "" })) : records).map(
			(record) => ({
				id: record.id,
				description: record.description,
				status: record.status,
				startedAt: record.startedAt,
				...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
			}),
		),
	});
	const { milestones, peaks, byStep } = buildMilestones(events, steps);
	for (const [stepIndex, eventIds] of byStep) {
		const step = steps[stepIndex];
		if (step) step.eventIds = eventIds;
	}
	applyDetailWindow(steps, stepItemIds, input.detailSteps ?? 300);

	const files = aggregateFiles(collectFileOps({ entries, steps }), "lines" as FileSort);
	const commands = collectCommands({ entries, steps, mode: input.mode });
	const tools = aggregateTools(executions, input.toolInfos ?? [], steps.length);

	applyBodyCaps(items, bodies, truncation, input.bodyScale ?? 1);
	if (steps.some((step) => !step.hasDetails)) {
		truncation.push({ kind: "stepDetails", limit: 300, actual: steps.filter((step) => !step.hasDetails).length });
	}
	if (usage.items.length > USAGE_ROW_LIMIT) {
		truncation.push({ kind: "usageRows", limit: USAGE_ROW_LIMIT, actual: usage.items.length });
	}

	const usageRows: UsageRow[] = usage.items.slice(0, USAGE_ROW_LIMIT).map((item) => ({
		entryId: item.entryId,
		timestamp: item.timestamp,
		source: item.source,
		...(item.provider === undefined ? {} : { provider: item.provider }),
		...(item.model === undefined ? {} : { model: item.model }),
		input: item.usage.input,
		output: item.usage.output,
		cacheRead: item.usage.cacheRead,
		cacheWrite: item.usage.cacheWrite,
		cost: item.usage.cost.total,
	}));

	const first = entries[0]?.timestamp ?? new Date(0).toISOString();
	const last = entries.at(-1)?.timestamp ?? first;
	const lastAssistant = [...branch]
		.reverse()
		.find((entry) => entry.type === "message" && entry.message.role === "assistant");
	const metadata: ReportMetadata = {
		id: input.manager.getSessionId(),
		...(input.manager.getSessionName() === undefined ? {} : { name: input.manager.getSessionName() }),
		cwd: input.cwd,
		...(input.manager.getSessionFile() === undefined ? {} : { filePath: input.manager.getSessionFile() }),
		...(input.model === undefined ? {} : { model: input.model }),
		thinkingLevel: input.thinkingLevel ?? input.manager.buildSessionProjection().thinkingLevel,
		startedAt: first,
		endedAt: last,
		branchEntries: branch.length,
		totalEntries: entries.length,
	};
	if (lastAssistant?.type === "message" && lastAssistant.message.role === "assistant" && metadata.model === undefined) {
		metadata.model = `${lastAssistant.message.provider}/${lastAssistant.message.responseModel ?? lastAssistant.message.model}`;
	}

	const currentContext = currentContextOf({
		usage: input.contextUsage,
		steps,
		finalEstimate,
		finalSums,
		window: input.window,
		reserveTokens: input.reserveTokens,
		reserveEnabled: input.reserveEnabled,
		maxTokens: input.maxTokens,
	});

	if (steps.length > 0 && steps[0]?.system === null) {
		warnings.push({ key: "warning.noSystem" });
	}
	const members = input.family?.members ?? [];
	for (const member of members) {
		if (!member.child) warnings.push({ key: "warning.brokenChild", params: { id: member.id } });
	}

	const durationMs = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
	return {
		schema: 2,
		mode: input.mode,
		lang: input.lang,
		metadata,
		kpis: kpisOf({ usage, timing, steps, turns, toolRows: tools, members }),
		usage,
		usageRows,
		steps,
		turns,
		items,
		bodies,
		events,
		milestones,
		peaks,
		currentContext,
		timing: { ...timing, modelMs: durationMs > 0 ? timing.modelMs : timing.modelMs },
		tools,
		files,
		commands,
		warnings,
		truncation,
	};
}

function childSessionOf(
	filePath: string,
): { child: import("./family").ChildSession; manager: ReadonlySessionManager } | undefined {
	let manager: ReadonlySessionManager;
	try {
		manager = SessionManagerClass.open(filePath);
	} catch {
		return undefined;
	}
	const header = manager.getHeader();
	if (header === undefined || header === null) return undefined;
	const entries = manager.getEntries();
	const branch = manager.getBranch();
	const firstUser = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
	const briefText =
		firstUser?.type === "message" && firstUser.message.role === "user"
			? typeof firstUser.message.content === "string"
				? firstUser.message.content
				: ""
			: undefined;
	const records = parseSubagentRecords(entries);

	return {
		manager,
		child: {
			id: header.id,
			...(header.parentSession === undefined ? {} : { parentId: header.parentSession }),
			...(briefText === undefined ? {} : { brief: briefText.slice(0, 160) }),
			steps: branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length,
			records,
		},
	};
}

function isLifetime(value: unknown): value is { input: number; output: number; cacheWrite: number } {
	if (typeof value !== "object" || value === null) return false;
	const usage = value as Record<string, unknown>;
	return ["input", "output", "cacheWrite"].every((key) => typeof usage[key] === "number" && Number.isFinite(usage[key]));
}

function trimSessionId(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value.endsWith(".jsonl") ? basename(value, ".jsonl") : value;
}

function parseSubagentRecords(entries: readonly SessionEntry[]): SubagentRecord[] {
	const records: SubagentRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "subagents:record") continue;
		const data = (entry.data ?? {}) as Record<string, unknown>;
		if (typeof data.id !== "string" || typeof data.status !== "string") continue;
		records.push({
			id: data.id,
			type: typeof data.type === "string" ? data.type : "unknown",
			description: typeof data.description === "string" ? data.description : data.id,
			status: data.status,
			...(typeof data.result === "string" ? { result: data.result } : {}),
			...(typeof data.error === "string" ? { error: data.error } : {}),
			startedAt: typeof data.startedAt === "number" ? data.startedAt : Date.parse(entry.timestamp),
			...(typeof data.completedAt === "number" ? { completedAt: data.completedAt } : {}),
			...(typeof data.toolUses === "number" ? { toolUses: data.toolUses } : {}),
			...(typeof data.modelName === "string" ? { modelName: data.modelName } : {}),
			...(typeof data.thinking === "string" ? { thinking: data.thinking } : {}),
			...(typeof data.outputFile === "string" ? { outputFile: data.outputFile } : {}),
			...(isLifetime(data.lifetimeUsage) ? { lifetimeUsage: data.lifetimeUsage } : {}),
			...(typeof data.lifetimeCost === "number" ? { lifetimeCost: data.lifetimeCost } : {}),
		});
	}
	return records;
}

/** Build the full report for the current session, including its agent family. */
export function buildReport(
	ctx: ExtensionCommandContext,
	options: { mode: "full" | "short"; lang: Lang; generatedAt?: Date; bodyScale?: number; detailSteps?: number },
): InsightReport {
	const generatedAt = (options.generatedAt ?? new Date()).toISOString();
	const contextUsage = ctx.getContextUsage();
	const actions = ctx as ExtensionCommandContext & HostActions;
	const settings = actions.getSettings?.() ?? {};
	const compaction = settings.compaction ?? {};
	const window = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const reserveTokens = compaction.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const reserveEnabled = compaction.enabled !== false;
	const maxTokens = ctx.model?.maxTokens ?? 0;
	const toolInfos = actions.getAllTools?.() ?? [];

	const parentManager = ctx.sessionManager;
	const records = parseSubagentRecords(parentManager.getEntries());

	const parentId = parentManager.getSessionId();
	const parentFile = parentManager.getSessionFile();
	const loaded = new Map<string, ReadonlySessionManager>();
	const { members, warnings } = collectFamily({
		parentSessionId: parentId,
		records,
		mode: options.mode,
		loadChild: (outputFile, expectedParent) => {
			const opened = childSessionOf(outputFile);
			if (opened === undefined) return undefined;
			const headerParent = trimSessionId(opened.manager.getHeader()?.parentSession);
			const accepted =
				headerParent === expectedParent ||
				opened.child.parentId === expectedParent ||
				(expectedParent === parentId &&
					(headerParent === trimSessionId(parentFile) || opened.child.parentId === parentFile));
			if (!accepted) return { ...opened.child, parentId: "mismatch" };
			loaded.set(opened.child.id, opened.manager);
			return opened.child;
		},
	});

	const sorted = sortFamily(members);
	const report = buildSessionReport({
		manager: parentManager,
		cwd: ctx.cwd,
		mode: options.mode,
		lang: options.lang,
		bodyScale: options.bodyScale ?? 1,
		detailSteps: options.detailSteps ?? 300,
		...(ctx.model === undefined ? {} : { model: `${ctx.model.provider}/${ctx.model.id}` }),
		thinkingLevel: ctx.thinkingLevel,
		...(contextUsage === undefined ? {} : { contextUsage }),
		toolInfos,
		window,
		maxTokens,
		reserveTokens,
		reserveEnabled,
		family: { members: sorted, children: [] },
	});

	report.warnings.push(...warnings);

	const children: InsightReport["family"]["children"] = [];
	for (const member of sorted) {
		const manager = loaded.get(member.id);
		if (manager === undefined) continue;
		const childReport = buildSessionReport({
			manager,
			cwd: ctx.cwd,
			mode: options.mode,
			lang: options.lang,
			thinkingLevel: manager.buildSessionProjection().thinkingLevel,
			window,
			maxTokens,
			reserveTokens,
			reserveEnabled,
			family: { members: [], children: [] },
		});
		children.push({ member, report: { ...childReport, generatedAt, family: { members: [], children: [] } } });
	}

	return { ...report, generatedAt, family: { members: sorted, children } };
}
