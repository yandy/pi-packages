import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	estimateMessageTokens,
	estimateTextAndImageContentTokens,
	estimateTextTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import type { ContextUsage, SessionProjection } from "@earendil-works/pi-coding-agent";
import type { ContextCategory, ContextCategoryId, ContextComposition } from "./model";

export type { ContextCategoryId } from "./model";

const CATEGORY_IDS: ContextCategoryId[] = [
	"system",
	"toolDefinitions",
	"user",
	"injected",
	"compaction",
	"reasoning",
	"answers",
	"toolCalls",
	"toolResults",
];

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function estimateTools(tools: readonly unknown[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}

function estimateContent(content: string | Array<TextContent | ImageContent>): number {
	return estimateTextAndImageContentTokens(content);
}

export function analyzeContextProjection(
	projection: SessionProjection,
	options: { usage?: ContextUsage; fallbackSystemPrompt?: string } = {},
): ContextComposition {
	const categories: Record<ContextCategoryId, ContextCategory> = {
		system: { id: "system", tokens: 0 },
		toolDefinitions: { id: "toolDefinitions", tokens: 0 },
		user: { id: "user", tokens: 0 },
		injected: { id: "injected", tokens: 0 },
		compaction: { id: "compaction", tokens: 0 },
		reasoning: { id: "reasoning", tokens: 0 },
		answers: { id: "answers", tokens: 0 },
		toolCalls: { id: "toolCalls", tokens: 0 },
		toolResults: { id: "toolResults", tokens: 0 },
	};
	const warnings: string[] = [];
	let complete = true;
	let hasSystemMessage = false;

	const add = (id: ContextCategoryId, tokens: number) => {
		const category = categories[id];
		category.tokens = (category.tokens ?? 0) + tokens;
	};

	for (const message of projection.messages) {
		if (message.role === "system") {
			hasSystemMessage = true;
			const toolTokens = estimateTools(message.toolsAdded) + estimateTools(message.toolsRemoved);
			add("system", Math.max(0, estimateMessageTokens(message) - toolTokens));
			add("toolDefinitions", toolTokens);
			continue;
		}
		if (message.role === "user") {
			add("user", estimateContent(message.content));
			continue;
		}
		if (message.role === "assistant") {
			if (!Array.isArray(message.content)) {
				complete = false;
				warnings.push("Invalid assistant content was not included in the estimate");
				continue;
			}
			for (const block of message.content as unknown[]) {
				if (typeof block !== "object" || block === null) {
					complete = false;
					warnings.push("Unknown assistant block was not included in the estimate");
					continue;
				}
				const candidate = block as {
					type?: unknown;
					text?: unknown;
					thinking?: unknown;
					name?: unknown;
					arguments?: unknown;
				};
				if (candidate.type === "text" && typeof candidate.text === "string")
					add("answers", estimateTextTokens(candidate.text));
				else if (candidate.type === "thinking" && typeof candidate.thinking === "string") {
					add("reasoning", estimateTextTokens(candidate.thinking));
				} else if (candidate.type === "toolCall" && typeof candidate.name === "string") {
					add("toolCalls", estimateTextTokens(candidate.name + safeJsonStringify(candidate.arguments)));
				} else {
					complete = false;
					warnings.push(`Unknown assistant block was not included in the estimate: ${String(candidate.type)}`);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			add("toolResults", estimateContent(message.content));
			continue;
		}
		if (message.role === "custom") {
			add("injected", estimateContent(message.content));
			continue;
		}
		if (message.role === "branchSummary") {
			add("injected", estimateTextTokens(message.summary));
			continue;
		}
		if (message.role === "compactionSummary") {
			add("compaction", estimateTextTokens(message.summary));
			continue;
		}
		if (message.role === "bashExecution") {
			if (message.excludeFromContext === true) continue;
			add("user", estimateTextTokens(message.output ? `${message.command}\n${message.output}` : message.command));
			continue;
		}
		complete = false;
		warnings.push(
			`Unknown message role was not included in the estimate: ${String((message as { role?: unknown }).role)}`,
		);
	}

	if (!hasSystemMessage) {
		if (options.fallbackSystemPrompt !== undefined) add("system", estimateTextTokens(options.fallbackSystemPrompt));
		categories.toolDefinitions = { id: "toolDefinitions", tokens: null };
		complete = false;
		warnings.push("Tool definitions are unavailable for this session; the composition is a partial estimate");
	}

	const ordered = CATEGORY_IDS.map((id) => categories[id]);
	return {
		...(options.usage === undefined ? {} : { usage: options.usage }),
		categories: ordered,
		estimatedTotal: ordered.reduce((sum, category) => sum + (category.tokens ?? 0), 0),
		complete,
		warnings,
	};
}
