import { estimateTextAndImageContentTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import { stepIndexOf } from "../session/steps";

export type ToolExecutionStatus = "ok" | "error" | "missing" | "unfinished";

export interface ToolExecutionV2 {
	id: string;
	name: string;
	nested: boolean;
	status: ToolExecutionStatus;
	callTimestamp: number;
	durationMs?: number;
	durationEstimated: boolean;
	stepIndex: number;
	tokens: number;
	argumentsBytes: number;
}

export interface ToolRow {
	name: string;
	source: "builtin" | "user" | "project";
	sourceLabel: string;
	calls: number;
	ok: number;
	errors: number;
	missing: number;
	unfinished: number;
	durationMs: number;
	durationEstimated: boolean;
	tokens: number;
	firstStep?: number;
	lastStep?: number;
	perStep: number[];
}

function jsonLength(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
	} catch {
		return 0;
	}
}

function tokensOf(content: unknown): number {
	if (typeof content === "string") return estimateTextTokens(content);
	if (!Array.isArray(content)) return 0;
	return estimateTextAndImageContentTokens(content as never);
}

/** Every tool call, paired with its result when one exists. */
export function collectToolExecutions(args: {
	entries: readonly SessionEntry[];
	steps?: ReadonlyArray<{ index: number; timestamp: number }>;
}): ToolExecutionV2[] {
	const { entries, steps = [] } = args;
	const executions: ToolExecutionV2[] = [];
	const byId = new Map<string, ToolExecutionV2>();

	const make = (id: string, name: string, callTimestamp: number, nested: boolean): ToolExecutionV2 => {
		const execution: ToolExecutionV2 = {
			id,
			name,
			nested,
			status: "missing",
			callTimestamp,
			durationEstimated: false,
			stepIndex: steps.length > 0 ? stepIndexOf(callTimestamp, steps) : 0,
			tokens: 0,
			argumentsBytes: 0,
		};
		executions.push(execution);
		byId.set(id, execution);
		return execution;
	};

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of (message.content ?? []) as Array<{
				type?: unknown;
				id?: unknown;
				name?: unknown;
				arguments?: unknown;
			}>) {
				if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
				const execution = make(block.id, block.name, message.timestamp, false);
				execution.argumentsBytes = jsonLength(block.arguments);
				execution.tokens = estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.arguments) ?? "");
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		// An orphan result (no matching call) contributes no top-level execution, but the
		// nested calls it recorded are real and still count.
		const execution = byId.get(message.toolCallId);
		if (execution !== undefined) {
			execution.status = message.isError ? "error" : "ok";
			execution.tokens += tokensOf(message.content);
			if (typeof message.durationMs === "number") {
				execution.durationMs = message.durationMs;
				execution.durationEstimated = false;
			} else {
				execution.durationMs = Math.max(0, message.timestamp - execution.callTimestamp);
				execution.durationEstimated = true;
			}
		}
		for (const nested of message.nestedCalls?.calls ?? []) {
			const nestedExecution = make(`${message.toolCallId}/${nested.id}`, nested.name, message.timestamp, true);
			nestedExecution.status = nested.status;
			nestedExecution.argumentsBytes = nested.argumentsBytes ?? jsonLength(nested.arguments);
			nestedExecution.tokens =
				estimateTextTokens(nested.name) + estimateTextTokens(JSON.stringify(nested.arguments) ?? "");
			if (typeof nested.durationMs === "number") nestedExecution.durationMs = nested.durationMs;
		}
	}

	return executions;
}

function sourceOf(info: ToolInfo | undefined): { source: ToolRow["source"]; sourceLabel: string } {
	if (info === undefined) return { source: "user", sourceLabel: "" };
	const { path, source, scope } = info.sourceInfo;
	if (path.startsWith("builtin:") || source === "builtin") return { source: "builtin", sourceLabel: "builtin" };
	if (scope === "project") return { source: "project", sourceLabel: source || path };
	return { source: "user", sourceLabel: source || path };
}

/** One row per tool, with the per-step distribution the tool card draws. */
export function aggregateTools(
	executions: readonly ToolExecutionV2[],
	infos: readonly ToolInfo[],
	stepCount = 0,
): ToolRow[] {
	const rows = new Map<string, ToolRow>();
	const steps = stepCount > 0 ? stepCount : Math.max(0, ...executions.map((execution) => execution.stepIndex + 1));
	for (const execution of executions) {
		let row = rows.get(execution.name);
		if (row === undefined) {
			const { source, sourceLabel } = sourceOf(infos.find((info) => info.name === execution.name));
			row = {
				name: execution.name,
				source,
				sourceLabel,
				calls: 0,
				ok: 0,
				errors: 0,
				missing: 0,
				unfinished: 0,
				durationMs: 0,
				durationEstimated: false,
				tokens: 0,
				perStep: new Array(steps).fill(0) as number[],
			};
			rows.set(execution.name, row);
		}
		row.calls += 1;
		if (execution.status === "ok") row.ok += 1;
		else if (execution.status === "error") row.errors += 1;
		else if (execution.status === "unfinished") row.unfinished += 1;
		else row.missing += 1;
		if (execution.durationEstimated) row.durationEstimated = true;
		row.durationMs += execution.durationMs ?? 0;
		row.tokens += execution.tokens;
		row.firstStep = row.firstStep === undefined ? execution.stepIndex : Math.min(row.firstStep, execution.stepIndex);
		row.lastStep = row.lastStep === undefined ? execution.stepIndex : Math.max(row.lastStep, execution.stepIndex);
		const slot = row.perStep[execution.stepIndex];
		if (slot !== undefined) row.perStep[execution.stepIndex] = slot + 1;
	}
	return [...rows.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}
