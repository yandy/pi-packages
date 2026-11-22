import type { Usage } from "@earendil-works/pi-ai";
import type { ContextUsage, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";

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

export type ExecutionStatus = "ok" | "error" | "missing" | "unfinished";

export interface ToolExecution {
	id: string;
	name: string;
	nested: boolean;
	status: ExecutionStatus;
	timestamp: string;
	durationMs?: number;
	durationEstimated: boolean;
}

export interface ToolSummary {
	name: string;
	nested: boolean;
	calls: number;
	ok: number;
	errors: number;
	missing: number;
	unfinished: number;
	durationMs: number;
}

export interface FileActivity {
	path: string;
	read: number;
	written: number;
	edited: number;
	searched: number;
	addedLines: number;
	removedLines: number;
}

export interface CommandActivity {
	id: string;
	source: "bash" | "powershell" | "user-bash";
	nested: boolean;
	command: string;
	status: "ok" | "error" | "cancelled" | "missing";
	timestamp: string;
	exitCode?: number;
	durationMs?: number;
	durationEstimated: boolean;
}

export interface ActivityReport {
	executions: ToolExecution[];
	tools: ToolSummary[];
	files: FileActivity[];
	commands: CommandActivity[];
}

export interface TimingReport {
	startedAt?: string;
	endedAt?: string;
	wallTimeMs: number;
	modelTimeMs: number;
	toolTimeMs: number;
	modelTimeIncomplete: boolean;
	toolTimeEstimated: boolean;
}

export interface ContextEvent {
	id: string;
	timestamp: string;
	type: "compaction" | "branch_summary" | "context_edit" | "model_change" | "thinking_level_change" | "subagent";
	label: string;
	tokensBefore?: number;
	targetId?: string;
}

export interface SubagentMetadata {
	id: string;
	type: string;
	description: string;
	status: string;
	filePath: string;
	modelName?: string;
	thinking?: string;
	startedAt?: number;
	completedAt?: number;
}

export interface LoadedSubagent {
	manager: SessionManager;
	metadata: SubagentMetadata;
}

export interface SubagentLoadResult {
	sessions: LoadedSubagent[];
	warnings: string[];
}
