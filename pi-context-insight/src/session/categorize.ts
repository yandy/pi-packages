import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { estimateTextAndImageContentTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

type SessionMessage = Extract<SessionEntry, { type: "message" }>["message"];

import type { CategoryId } from "../model";
import { type ReplayedSystem, SYSTEM_SECTION_CATEGORY } from "./replay";

export type ItemKind =
	| "systemSection"
	| "toolDefinition"
	| "message"
	| "block"
	| "toolResult"
	| "custom"
	| "summary"
	| "compactionSummary";

export interface Item {
	id: number;
	entryId: string;
	category: CategoryId;
	kind: ItemKind;
	tag: string;
	tokens: number;
	textIndex: number | null;
	toolCallId?: string;
	isError?: boolean;
	block?: "thinking" | "text" | "toolCall";
	skillName?: string;
	/** Entry timestamp, so row metadata can show when the item entered the transcript. */
	timestamp?: number;
	truncated?: boolean;
}

interface ContentBlock {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	arguments?: unknown;
}

function jsonText(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function contentText(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			return block.type === "image" ? `[image ${block.mimeType}]` : "";
		})
		.join("\n");
}

export function skillNameOfPath(path: string): string | undefined {
	const normalized = path.replace(/\\/g, "/");
	if (!/\/SKILL\.md$/i.test(normalized)) return undefined;
	const parts = normalized.split("/");
	return parts[parts.length - 2] || undefined;
}

function messageItems(args: {
	message: SessionMessage;
	entry: SessionEntry;
	nextId: () => number;
	putBody: (text: string) => number | null;
	callArgs?: (toolCallId: string) => Record<string, unknown> | undefined;
}): Item[] {
	const { message, entry, nextId, putBody, callArgs } = args;
	const items: Item[] = [];
	const push = (partial: Omit<Item, "id" | "entryId">): void => {
		items.push({ id: nextId(), entryId: entry.id, ...partial });
	};

	if (message.role === "system") {
		const base = typeof message.content === "string" ? message.content : contentText(message.content);
		if (base.trim().length > 0) {
			push({
				category: "systemBase",
				kind: "systemSection",
				tag: "base",
				tokens: estimateTextTokens(base),
				textIndex: putBody(base),
			});
		}
		const sections: Record<string, string | null> = message.sections ?? {};
		for (const [name, text] of Object.entries(sections)) {
			if (text === null || text.trim().length === 0) continue;
			push({
				category: SYSTEM_SECTION_CATEGORY[name] ?? "systemOther",
				kind: "systemSection",
				tag: name,
				tokens: estimateTextTokens(text),
				textIndex: putBody(text),
			});
		}
		for (const candidate of message.toolsAdded ?? []) {
			const tool = candidate as { name?: unknown };
			if (typeof tool.name !== "string") continue;
			const text = jsonText(candidate);
			push({
				category: "toolDefinitions",
				kind: "toolDefinition",
				tag: tool.name,
				tokens: estimateTextTokens(text),
				textIndex: putBody(text),
			});
		}
		return items;
	}

	if (message.role === "user") {
		const text = contentText(message.content);
		push({
			category: "user",
			kind: "message",
			tag: "user",
			tokens: estimateTextAndImageContentTokens(message.content),
			textIndex: putBody(text),
		});
		return items;
	}

	if (message.role === "assistant") {
		if (!Array.isArray(message.content)) return items;
		for (const raw of message.content) {
			const block = raw as ContentBlock;
			if (block.type === "thinking" && typeof block.thinking === "string") {
				push({
					category: "reasoning",
					kind: "block",
					block: "thinking",
					tag: "thinking",
					tokens: estimateTextTokens(block.thinking),
					textIndex: putBody(block.thinking),
				});
			} else if (block.type === "text" && typeof block.text === "string") {
				push({
					category: "answers",
					kind: "block",
					block: "text",
					tag: "answer",
					tokens: estimateTextTokens(block.text),
					textIndex: putBody(block.text),
				});
			} else if (block.type === "toolCall" && typeof block.name === "string") {
				const text = `${block.name} ${jsonText(block.arguments)}`;
				push({
					category: "toolCalls",
					kind: "block",
					block: "toolCall",
					tag: block.name,
					tokens: estimateTextTokens(text),
					textIndex: putBody(text),
					...(typeof (raw as { id?: unknown }).id === "string" ? { toolCallId: (raw as { id: string }).id } : {}),
				});
			}
		}
		return items;
	}

	if (message.role === "toolResult") {
		const args = callArgs?.(message.toolCallId);
		const path = typeof args?.path === "string" ? args.path : typeof args?.command === "string" ? args.command : "";
		const skillName = message.toolName === "read" ? skillNameOfPath(path) : undefined;
		const text = contentText(message.content);
		push({
			category: skillName === undefined ? "toolResults" : "skillInjections",
			kind: "toolResult",
			tag: message.toolName,
			tokens: estimateTextAndImageContentTokens(message.content),
			textIndex: putBody(text),
			toolCallId: message.toolCallId,
			isError: message.isError,
			...(skillName === undefined ? {} : { skillName }),
		});
		return items;
	}

	if (message.role === "custom") {
		const isSkill = /skill/i.test(message.customType) || /^#\s*\S*skill/i.test(contentText(message.content));
		const text = contentText(message.content);
		push({
			category: isSkill ? "skillInjections" : "injected",
			kind: "custom",
			tag: message.customType,
			tokens: estimateTextAndImageContentTokens(message.content),
			textIndex: putBody(text),
		});
		return items;
	}

	if (message.role === "branchSummary") {
		push({
			category: "injected",
			kind: "summary",
			tag: "branchSummary",
			tokens: estimateTextTokens(message.summary),
			textIndex: putBody(message.summary),
		});
		return items;
	}

	if (message.role === "compactionSummary") {
		push({
			category: "compaction",
			kind: "compactionSummary",
			tag: "compaction",
			tokens: estimateTextTokens(message.summary),
			textIndex: putBody(message.summary),
		});
		return items;
	}

	if (message.role === "bashExecution") {
		if (message.excludeFromContext === true) return items;
		const text = message.output ? `${message.command}\n${message.output}` : message.command;
		push({
			category: "user",
			kind: "message",
			tag: "bashExecution",
			tokens: estimateTextTokens(text),
			textIndex: putBody(text),
		});
	}

	return items;
}

/**
 * Turn one session entry into the context items it contributes at that point in the
 * transcript. `system` is the state replayed up to and including this entry; it is unused
 * for non-system entries today but keeps the call site uniform as the model evolves.
 */
/** Materialise a replayed system state: the accumulated base prompt, every section and every tool. */
export function systemItemsOf(
	system: ReplayedSystem | null,
	entryId: string,
	nextId: () => number,
	putBody: (text: string) => number | null,
): Item[] {
	if (system === null) return [];
	const items: Item[] = [];
	const push = (partial: Omit<Item, "id" | "entryId">): void => {
		items.push({ id: nextId(), entryId, ...partial });
	};
	if (system.base.trim().length > 0) {
		push({
			category: "systemBase",
			kind: "systemSection",
			tag: "base",
			tokens: estimateTextTokens(system.base),
			textIndex: putBody(system.base),
		});
	}
	for (const [name, text] of Object.entries(system.sections)) {
		if (text === null || text.trim().length === 0) continue;
		push({
			category: SYSTEM_SECTION_CATEGORY[name] ?? "systemOther",
			kind: "systemSection",
			tag: name,
			tokens: estimateTextTokens(text),
			textIndex: putBody(text),
		});
	}
	for (const tool of system.tools) {
		const text = jsonText(tool);
		push({
			category: "toolDefinitions",
			kind: "toolDefinition",
			tag: tool.name,
			tokens: estimateTextTokens(text),
			textIndex: putBody(text),
		});
	}
	return items;
}

function customEntryItems(entry: SessionEntry, nextId: () => number, putBody: (text: string) => number | null): Item[] {
	if (entry.type === "custom_message") {
		const content = entry.content ?? "";
		const text = typeof content === "string" ? content : contentText(content);
		const isSkill = /skill/i.test(entry.customType);
		return [
			{
				id: nextId(),
				entryId: entry.id,
				category: isSkill ? "skillInjections" : "injected",
				kind: "custom",
				tag: entry.customType,
				tokens: estimateTextAndImageContentTokens(content),
				textIndex: putBody(text),
			},
		];
	}
	if (entry.type === "branch_summary") {
		return [
			{
				id: nextId(),
				entryId: entry.id,
				category: "injected",
				kind: "summary",
				tag: "branchSummary",
				tokens: estimateTextTokens(entry.summary),
				textIndex: putBody(entry.summary),
			},
		];
	}
	return [];
}

export function extractItems(args: {
	entry: SessionEntry;
	system: ReplayedSystem | null;
	nextId: () => number;
	putBody: (text: string) => number | null;
	callArgs?: (toolCallId: string) => Record<string, unknown> | undefined;
}): Item[] {
	const { entry } = args;
	if (entry.type === "custom_message" || entry.type === "branch_summary") {
		return customEntryItems(entry, args.nextId, args.putBody);
	}
	if (entry.type === "compaction") {
		const item: Item = {
			id: args.nextId(),
			entryId: entry.id,
			category: "compaction",
			kind: "compactionSummary",
			tag: "compaction",
			tokens: estimateTextTokens(entry.summary),
			textIndex: args.putBody(entry.summary),
		};
		return [item];
	}
	if (entry.type !== "message") return [];
	return messageItems({
		message: entry.message,
		entry,
		nextId: args.nextId,
		putBody: args.putBody,
		callArgs: args.callArgs,
	});
}
