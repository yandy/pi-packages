import type { Usage } from "@earendil-works/pi-ai";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";

export type CostBasis = "provider" | "estimate" | "mixed";

export interface UsageAggregate {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	prompt: number;
	total: number;
	cost: number;
	cacheHitRate: number | null;
	costBasis: CostBasis;
}

export interface UsageLedgerItem {
	entryId: string;
	timestamp: string;
	source: string;
	provider?: string;
	model?: string;
	note?: string;
	usage: Usage;
}

export interface UsageLedger {
	items: UsageLedgerItem[];
	warnings: string[];
}

export interface UsageReport extends UsageLedger {
	total: UsageAggregate;
	direct: UsageAggregate;
	forwardedSubagents: UsageAggregate;
	byModel: Array<{ key: string; totals: UsageAggregate }>;
}

export type ContextCategoryId =
	| "system"
	| "toolDefinitions"
	| "user"
	| "injected"
	| "compaction"
	| "reasoning"
	| "answers"
	| "toolCalls"
	| "toolResults";

export interface ContextCategory {
	id: ContextCategoryId;
	tokens: number | null;
}

export interface ContextComposition {
	usage?: ContextUsage;
	categories: ContextCategory[];
	estimatedTotal: number;
	complete: boolean;
	warnings: string[];
}
