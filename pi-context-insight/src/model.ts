import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ReadonlySessionManager = ExtensionContext["sessionManager"];

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

export type Lang = "en" | "zh";

export type CategoryId =
	| "systemBase"
	| "systemTools"
	| "systemProject"
	| "systemSkills"
	| "systemDocs"
	| "systemOther"
	| "toolDefinitions"
	| "user"
	| "injected"
	| "skillInjections"
	| "compaction"
	| "reasoning"
	| "answers"
	| "toolCalls"
	| "toolResults"
	| "unattributed";

export const CATEGORY_ORDER: readonly CategoryId[] = [
	"systemBase",
	"systemTools",
	"systemProject",
	"systemSkills",
	"systemDocs",
	"systemOther",
	"toolDefinitions",
	"user",
	"injected",
	"skillInjections",
	"compaction",
	"reasoning",
	"answers",
	"toolCalls",
	"toolResults",
	"unattributed",
];

export interface Msg {
	key: string;
	params?: Record<string, string | number>;
}

export interface ReportMetadata {
	id: string;
	name?: string;
	cwd: string;
	filePath?: string;
	model?: string;
	thinkingLevel?: string;
	startedAt: string;
	endedAt: string;
	branchEntries: number;
	totalEntries: number;
}

export interface Kpis {
	tokens: number;
	prompt: number;
	output: number;
	cost: number;
	costBasis: CostBasis;
	cacheHitRate: number | null;
	modelCalls: number;
	turns: number;
	toolCalls: number;
	activeMs: number;
	modelMs: number;
	toolMs: number;
	subagents: number;
	forwardedPrompt: number;
	forwardedCost: number;
}

export interface CurrentContext {
	tokens: number | null;
	estimated: boolean;
	window: number;
	percent: number | null;
	categories: Record<CategoryId, number>;
	reserveTokens: number;
	reserveEnabled: boolean;
	maxTokens: number;
	unknownSystem: boolean;
}

export interface TruncationEntry {
	kind: "steps" | "stepDetails" | "items" | "body" | "usageRows" | "rows" | "bytes";
	limit: number;
	actual: number;
}
