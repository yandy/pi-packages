import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CostBasis, UsageAggregate, UsageLedger, UsageLedgerItem, UsageReport } from "../model";

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isUsage(value: unknown): value is Usage {
	if (typeof value !== "object" || value === null) return false;
	const usage = value as Partial<Usage>;
	return (
		isFiniteNumber(usage.input) &&
		isFiniteNumber(usage.output) &&
		isFiniteNumber(usage.cacheRead) &&
		isFiniteNumber(usage.cacheWrite) &&
		isFiniteNumber(usage.totalTokens) &&
		typeof usage.cost === "object" &&
		usage.cost !== null &&
		isFiniteNumber(usage.cost.total)
	);
}

export function collectUsageLedger(entries: readonly SessionEntry[]): UsageLedger {
	const items: UsageLedgerItem[] = [];
	const warnings: string[] = [];

	const append = (
		entry: SessionEntry,
		source: string,
		usage: unknown,
		model?: { provider?: string; model?: string; note?: string },
	) => {
		if (!isUsage(usage)) {
			warnings.push(`Usage entry ${entry.id} has malformed usage`);
			return;
		}
		items.push({
			entryId: entry.id,
			timestamp: entry.timestamp,
			source,
			...model,
			usage,
		});
	};

	for (const entry of entries) {
		if (entry.type === "usage") {
			append(entry, entry.kind || "usage", entry.usage, {
				provider: entry.provider,
				model: entry.model,
				...(entry.note === undefined ? {} : { note: entry.note }),
			});
			continue;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (entry.usage !== undefined) append(entry, entry.type, entry.usage);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			append(entry, "assistant", message.usage, {
				provider: message.provider,
				model: message.responseModel ?? message.model,
			});
		} else if (message.role === "toolResult" && message.usage !== undefined) {
			append(entry, `tool:${message.toolName}`, message.usage);
		}
	}
	return { items, warnings };
}

interface MutableAggregate {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	providerReports: number;
	estimatedReports: number;
}

function emptyAggregate(): MutableAggregate {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, providerReports: 0, estimatedReports: 0 };
}

function addItem(aggregate: MutableAggregate, item: UsageLedgerItem): void {
	aggregate.input += item.usage.input;
	aggregate.output += item.usage.output;
	aggregate.cacheRead += item.usage.cacheRead;
	aggregate.cacheWrite += item.usage.cacheWrite;
	aggregate.cost += item.usage.cost.total;
	if (item.usage.cost.totalFromProvider === true) aggregate.providerReports++;
	else aggregate.estimatedReports++;
}

function finishAggregate(aggregate: MutableAggregate): UsageAggregate {
	const prompt = aggregate.input + aggregate.cacheRead + aggregate.cacheWrite;
	let costBasis: CostBasis = "estimate";
	if (aggregate.providerReports > 0 && aggregate.estimatedReports > 0) costBasis = "mixed";
	else if (aggregate.providerReports > 0) costBasis = "provider";
	return {
		input: aggregate.input,
		output: aggregate.output,
		cacheRead: aggregate.cacheRead,
		cacheWrite: aggregate.cacheWrite,
		prompt,
		total: prompt + aggregate.output,
		cost: aggregate.cost,
		cacheHitRate: prompt > 0 ? aggregate.cacheRead / prompt : null,
		costBasis,
	};
}

export function summarizeUsage(ledger: UsageLedger): UsageReport {
	const total = emptyAggregate();
	const direct = emptyAggregate();
	const forwardedSubagents = emptyAggregate();
	const byModel = new Map<string, MutableAggregate>();

	for (const item of ledger.items) {
		addItem(total, item);
		addItem(item.source === "subagent" ? forwardedSubagents : direct, item);
		const key = item.provider && item.model ? `${item.provider}/${item.model}` : "Tools / summaries";
		let aggregate = byModel.get(key);
		if (!aggregate) {
			aggregate = emptyAggregate();
			byModel.set(key, aggregate);
		}
		addItem(aggregate, item);
	}

	return {
		items: [...ledger.items],
		warnings: [...ledger.warnings],
		total: finishAggregate(total),
		direct: finishAggregate(direct),
		forwardedSubagents: finishAggregate(forwardedSubagents),
		byModel: [...byModel].map(([key, aggregate]) => ({ key, totals: finishAggregate(aggregate) })),
	};
}

/**
 * Spread each step's billed cost across its estimated categories by token share.
 * The unattributed residual is never allocated: it is a difference, not content.
 */
export function allocateCost<T extends {
	sums: Record<string, number>;
	estimatedTotal: number;
	actual?: { cost: number };
	costByCategory?: Partial<Record<string, number>>;
}>(steps: readonly T[]): T[] {
	for (const step of steps) {
		const actual = step.actual;
		if (actual === undefined || step.estimatedTotal <= 0) continue;
		const allocated: Record<string, number> = {};
		for (const [category, tokens] of Object.entries(step.sums)) {
			if (category === "unattributed" || !(tokens > 0)) continue;
			allocated[category] = (tokens / step.estimatedTotal) * actual.cost;
		}
		step.costByCategory = allocated;
	}
	return steps as T[];
}
