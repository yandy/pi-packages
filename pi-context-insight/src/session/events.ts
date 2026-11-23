import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Msg } from "../model";
import { skillNameOfPath } from "./categorize";
import { type Step, stepIndexOf } from "./steps";

export type EventKind =
	| "compaction"
	| "contextEdit"
	| "branchSummary"
	| "model"
	| "thinking"
	| "skill"
	| "inject"
	| "delegate"
	| "childDone"
	| "ask"
	| "todo";

export interface InsightEvent {
	id: number;
	kind: EventKind;
	timestamp: number;
	stepIndex: number;
	text: Msg;
	tokens?: number;
	grossTokens?: number;
	count?: number;
	targetStepIndex?: number;
}

export interface Milestone {
	stepIndex: number;
	kind: EventKind | "longest" | "growth";
	eventIds: number[];
	metric?: number;
}

export interface SubagentRecordLite {
	id: string;
	description: string;
	status: string;
	startedAt: number;
	completedAt?: number;
}

const EVENT_FILTER_KINDS: readonly EventKind[] = [
	"compaction",
	"contextEdit",
	"branchSummary",
	"model",
	"thinking",
	"skill",
	"inject",
	"delegate",
	"childDone",
	"ask",
	"todo",
];

export function eventKinds(): readonly EventKind[] {
	return EVENT_FILTER_KINDS;
}

function firstStepAtOrAfter(timestamp: number, steps: readonly Step[]): Step | undefined {
	return steps.find((step) => step.timestamp >= timestamp);
}

interface ToolCallRecord {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	timestamp: number;
}

function toolCalls(entries: readonly SessionEntry[]): ToolCallRecord[] {
	const calls: ToolCallRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const timestamp = Date.parse(entry.timestamp);
		for (const block of (entry.message.content ?? []) as Array<{
			type?: unknown;
			id?: unknown;
			name?: unknown;
			arguments?: unknown;
		}>) {
			if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
			calls.push({
				id: block.id,
				name: block.name,
				arguments: (block.arguments as Record<string, unknown>) ?? {},
				timestamp: Number.isFinite(timestamp) ? timestamp : 0,
			});
		}
	}
	return calls;
}

/** Every event the report draws on the timeline, ordered by time. */
export function collectEvents(args: {
	entries: readonly SessionEntry[];
	steps: readonly Step[];
	subagentRecords: readonly SubagentRecordLite[];
}): InsightEvent[] {
	const { entries, steps, subagentRecords } = args;
	const events: InsightEvent[] = [];
	const push = (partial: Omit<InsightEvent, "id">): void => {
		events.push({ id: events.length, ...partial });
	};
	const calls = toolCalls(entries);

	for (const entry of entries) {
		const timestamp = Date.parse(entry.timestamp);
		if (!Number.isFinite(timestamp)) continue;
		const stepIndex = stepIndexOf(timestamp, steps);

		if (entry.type === "compaction") {
			const next = firstStepAtOrAfter(timestamp, steps);
			const net = next === undefined ? 0 : next.estimatedTotal - entry.tokensBefore;
			push({
				kind: "compaction",
				timestamp,
				stepIndex,
				text: { key: "event.compaction", params: { messages: entry.tokensBefore } },
				tokens: Math.min(0, net),
				grossTokens: entry.tokensBefore,
			});
			continue;
		}
		if (entry.type === "context_edit") {
			const previous = steps.filter((step) => step.timestamp < timestamp).at(-1);
			const next = firstStepAtOrAfter(timestamp, steps);
			const net = previous && next ? next.estimatedTotal - previous.estimatedTotal : 0;
			push({
				kind: "contextEdit",
				timestamp,
				stepIndex,
				text: { key: entry.replacement === null ? "event.contextEditRemove" : "event.contextEditReplace" },
				tokens: Math.min(0, net),
			});
			continue;
		}
		if (entry.type === "branch_summary") {
			push({ kind: "branchSummary", timestamp, stepIndex, text: { key: "event.branchSummary" } });
			continue;
		}
		if (entry.type === "model_change") {
			push({
				kind: "model",
				timestamp,
				stepIndex,
				text: { key: "event.model", params: { to: `${entry.provider}/${entry.modelId}` } },
			});
			continue;
		}
		if (entry.type === "thinking_level_change") {
			push({
				kind: "thinking",
				timestamp,
				stepIndex,
				text: { key: "event.thinking", params: { to: entry.thinkingLevel } },
			});
			continue;
		}
		if (entry.type === "custom_message") {
			const isSkill = /skill/i.test(entry.customType);
			push({
				kind: isSkill ? "skill" : "inject",
				timestamp,
				stepIndex,
				text: isSkill
					? { key: "event.skill", params: { name: entry.customType } }
					: { key: "event.inject", params: { customType: entry.customType } },
			});
			continue;
		}
		if (entry.type !== "message") continue;

		const message = entry.message;
		if (message.role === "toolResult") {
			const call = calls.find((candidate) => candidate.id === message.toolCallId);
			const path = typeof call?.arguments.path === "string" ? call.arguments.path : "";
			const skillName = call?.name === "read" ? skillNameOfPath(path) : undefined;
			if (skillName !== undefined) {
				push({ kind: "skill", timestamp, stepIndex, text: { key: "event.skill", params: { name: skillName } } });
			}
		}
	}

	for (const call of calls) {
		const timestamp = call.timestamp;
		const stepIndex = stepIndexOf(timestamp, steps);
		if (call.name === "ask_user") {
			push({ kind: "ask", timestamp, stepIndex, text: { key: "event.ask", params: { count: 1 } } });
			continue;
		}
		if (call.name === "todo") {
			const action = typeof call.arguments.action === "string" ? call.arguments.action : "set";
			const items = Array.isArray(call.arguments.items) ? call.arguments.items.length : 1;
			const count = action === "update" ? 1 : items;
			push({
				kind: "todo",
				timestamp,
				stepIndex,
				text: { key: action === "update" ? "event.todoUpdate" : "event.todoAdd", params: { count } },
				count,
			});
		}
	}

	for (const record of subagentRecords) {
		if (Number.isFinite(record.startedAt)) {
			push({
				kind: "delegate",
				timestamp: record.startedAt,
				stepIndex: stepIndexOf(record.startedAt, steps),
				text: { key: "event.delegate", params: { id: record.id, description: record.description } },
			});
		}
		if (record.completedAt !== undefined && Number.isFinite(record.completedAt)) {
			push({
				kind: "childDone",
				timestamp: record.completedAt,
				stepIndex: stepIndexOf(record.completedAt, steps),
				text: { key: "event.childDone", params: { id: record.id, status: record.status } },
			});
		}
	}

	return events
		.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)
		.map((event, index) => ({ ...event, id: index }));
}

/** Group events onto their steps and find the two Top-1 peaks. */
export function buildMilestones(
	events: readonly InsightEvent[],
	steps: readonly Step[],
): { milestones: Milestone[]; peaks: { longest?: number; growth?: number }; byStep: Map<number, number[]> } {
	const groups = new Map<number, number[]>();
	for (const event of events) {
		const list = groups.get(event.stepIndex) ?? [];
		list.push(event.id);
		groups.set(event.stepIndex, list);
	}

	const milestones: Milestone[] = [...groups].map(([stepIndex, eventIds]) => {
		const first = events.find((event) => event.id === eventIds[0]);
		return { stepIndex, kind: first?.kind ?? "inject", eventIds };
	});

	let longest: number | undefined;
	let longestValue = Number.NEGATIVE_INFINITY;
	let growth: number | undefined;
	let growthValue = 0;
	for (const step of steps) {
		if (step.activeMs > longestValue) {
			longestValue = step.activeMs;
			longest = step.index;
		}
		if (step.deltaTotal > growthValue) {
			growthValue = step.deltaTotal;
			growth = step.index;
		}
	}
	if (longest !== undefined)
		milestones.push({ stepIndex: longest, kind: "longest", eventIds: [], metric: longestValue });
	if (growth !== undefined) milestones.push({ stepIndex: growth, kind: "growth", eventIds: [], metric: growthValue });

	milestones.sort((a, b) => a.stepIndex - b.stepIndex);
	return {
		milestones,
		peaks: { ...(longest === undefined ? {} : { longest }), ...(growth === undefined ? {} : { growth }) },
		byStep: groups,
	};
}
