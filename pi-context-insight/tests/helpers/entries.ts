import type { SessionEntry } from "@earendil-works/pi-coding-agent";

let seq = 0;

export function resetEntryIds(): void {
	seq = 0;
}

function base(type: string, timestamp: number) {
	seq += 1;
	return {
		id: `e${seq}`,
		parentId: seq === 1 ? null : `e${seq - 1}`,
		timestamp: new Date(timestamp).toISOString(),
		type,
	};
}

export function tool(name: string, description = `${name} tool`) {
	return { name, description, parameters: { type: "object", properties: {} } };
}

export function systemEntry(opts: {
	content?: string;
	sections?: Record<string, string | null>;
	toolsAdded?: unknown[];
	toolsRemoved?: unknown[];
	timestamp: number;
}): SessionEntry {
	return {
		...base("message", opts.timestamp),
		message: {
			role: "system",
			content: opts.content ?? "",
			...(opts.sections === undefined ? {} : { sections: opts.sections }),
			...(opts.toolsAdded === undefined ? {} : { toolsAdded: opts.toolsAdded }),
			...(opts.toolsRemoved === undefined ? {} : { toolsRemoved: opts.toolsRemoved }),
			timestamp: opts.timestamp,
		},
	} as SessionEntry;
}

export function userEntry(text: string, timestamp: number): SessionEntry {
	return { ...base("message", timestamp), message: { role: "user", content: text, timestamp } } as SessionEntry;
}

export function assistantEntry(opts: {
	content: unknown[];
	usage?: unknown;
	durationMs?: number;
	timestamp: number;
	model?: string;
}): SessionEntry {
	return {
		...base("message", opts.timestamp),
		message: {
			role: "assistant",
			content: opts.content,
			provider: "p",
			model: opts.model ?? "m",
			...(opts.usage === undefined ? {} : { usage: opts.usage }),
			stopReason: "stop",
			timestamp: opts.timestamp,
			...(opts.durationMs === undefined ? {} : { durationMs: opts.durationMs }),
		},
	} as SessionEntry;
}

export function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
	return { type: "toolCall", id, name, arguments: args };
}

export function toolResultEntry(opts: {
	toolCallId: string;
	toolName: string;
	content: unknown[] | string;
	isError?: boolean;
	durationMs?: number;
	details?: unknown;
	timestamp: number;
}): SessionEntry {
	return {
		...base("message", opts.timestamp),
		message: {
			role: "toolResult",
			toolCallId: opts.toolCallId,
			toolName: opts.toolName,
			content: typeof opts.content === "string" ? [{ type: "text", text: opts.content }] : opts.content,
			isError: opts.isError ?? false,
			timestamp: opts.timestamp,
			...(opts.details === undefined ? {} : { details: opts.details }),
			...(opts.durationMs === undefined ? {} : { durationMs: opts.durationMs }),
		},
	} as SessionEntry;
}

export function customMessageEntry(customType: string, content: string, timestamp: number): SessionEntry {
	return { ...base("custom_message", timestamp), customType, content, display: true } as SessionEntry;
}

export function branchSummaryEntry(summary: string, fromId: string, timestamp: number): SessionEntry {
	return { ...base("branch_summary", timestamp), summary, fromId } as SessionEntry;
}

export function compactionEntry(opts: {
	summary: string;
	tokensBefore: number;
	firstKeptEntryId: string;
	timestamp: number;
	systemMessage?: unknown;
}): SessionEntry {
	return {
		...base("compaction", opts.timestamp),
		summary: opts.summary,
		tokensBefore: opts.tokensBefore,
		firstKeptEntryId: opts.firstKeptEntryId,
		...(opts.systemMessage === undefined ? {} : { systemMessage: opts.systemMessage }),
	} as SessionEntry;
}

export function contextEditEntry(
	targetId: string,
	replacement: { content: unknown } | null,
	timestamp: number,
): SessionEntry {
	return { ...base("context_edit", timestamp), targetId, replacement } as SessionEntry;
}

export function modelChangeEntry(provider: string, modelId: string, timestamp: number): SessionEntry {
	return { ...base("model_change", timestamp), provider, modelId } as SessionEntry;
}

export function thinkingChangeEntry(thinkingLevel: string, timestamp: number): SessionEntry {
	return { ...base("thinking_level_change", timestamp), thinkingLevel } as SessionEntry;
}

export function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number, fromProvider = false) {
	const quarter = cost / 4;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: quarter,
			output: quarter,
			cacheRead: quarter,
			cacheWrite: quarter,
			total: cost,
			totalFromProvider: fromProvider,
		},
	};
}
