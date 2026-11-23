import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Step } from "./steps";

export interface TimingReport {
	startMs: number;
	endMs: number;
	wallMs: number;
	activeMs: number;
	idleMs: number;
	modelMs: number;
	toolMs: number;
	otherMs: number;
	modelCalls: number;
	toolCalls: number;
	tps: number | null;
	estimated: { model: boolean; tool: boolean };
}

export interface ExecutionLite {
	name: string;
	nested: boolean;
	durationMs?: number;
	durationEstimated: boolean;
}

/** A gap this long between two events means the user walked away. */
export const IDLE_GAP_MS = 120_000;
const ASK_TOOL = "ask_user";

interface Beat {
	start: number;
	end: number;
}

function beatsOf(entries: readonly SessionEntry[]): Beat[] {
	const beats: Beat[] = [];
	for (const entry of entries) {
		const timestamp = Date.parse(entry.timestamp);
		if (!Number.isFinite(timestamp)) continue;
		let end = timestamp;
		if (entry.type === "message" && entry.message.role === "assistant" && typeof entry.message.durationMs === "number") {
			end = timestamp + entry.message.durationMs;
		}
		if (entry.type === "message" && entry.message.role === "toolResult" && typeof entry.message.durationMs === "number") {
			end = timestamp + entry.message.durationMs;
		}
		beats.push({ start: timestamp, end });
	}
	beats.sort((a, b) => a.start - b.start);
	return beats;
}

function idleWithin(
	window: Beat,
	beats: readonly Beat[],
	askWindows: ReadonlyArray<{ start: number; end: number }>,
): number {
	let idle = 0;
	const inside = beats.filter((beat) => beat.start >= window.start && beat.start <= window.end);
	for (let index = 1; index < inside.length; index++) {
		const current = inside[index];
		const previous = inside[index - 1];
		if (current === undefined || previous === undefined) continue;
		const gap = current.start - previous.end;
		if (gap >= IDLE_GAP_MS) idle += gap;
	}
	for (const ask of askWindows) {
		const overlap = Math.min(ask.end, window.end) - Math.max(ask.start, window.start);
		if (overlap > 0) idle += overlap;
	}
	return idle;
}

/**
 * Split wall time into model, tool and overhead, with user absence removed. Writes the
 * per-step split back onto the steps so the timeline and the totals never disagree.
 */
export function computeTiming(args: {
	entries: readonly SessionEntry[];
	steps: Step[];
	executions: readonly ExecutionLite[];
}): TimingReport {
	const { entries, steps, executions } = args;
	const beats = beatsOf(entries);
	const startMs = beats[0]?.start ?? 0;
	const endMs = beats.reduce((max, beat) => Math.max(max, beat.end), startMs);

	const durations = new Map<number, number>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const startedAt = Date.parse(entry.timestamp);
		const duration = entry.message.durationMs;
		if (!Number.isFinite(startedAt) || typeof duration !== "number") continue;
		durations.set(startedAt, duration);
	}

	let modelMs = 0;
	let modelEstimated = false;
	for (const step of steps) {
		if (typeof step.durationMs !== "number") step.durationMs = durations.get(step.timestamp);
		if (typeof step.durationMs === "number") {
			step.durationEstimated = false;
			modelMs += step.durationMs;
			continue;
		}
		modelEstimated = true;
		const previous = beats.filter((beat) => beat.start < step.timestamp).at(-1);
		step.durationEstimated = true;
		step.durationMs = Math.max(0, step.timestamp - (previous?.end ?? step.timestamp));
		modelMs += step.durationMs;
	}

	let toolMs = 0;
	let toolEstimated = false;
	let toolCalls = 0;
	for (const execution of executions) {
		toolCalls += 1;
		if (execution.nested) continue;
		if (execution.durationEstimated) toolEstimated = true;
		toolMs += execution.durationMs ?? 0;
	}

	const askWindows: Array<{ start: number; end: number }> = [];
	for (const execution of executions) {
		if (execution.name !== ASK_TOOL || execution.durationMs === undefined) continue;
		const duration = execution.durationMs;
		const beat = beats.find((candidate) => candidate.end - candidate.start >= duration);
		if (beat) askWindows.push({ start: beat.end - execution.durationMs, end: beat.end });
	}

	let idleMs = 0;
	for (const [index, step] of steps.entries()) {
		const next = steps[index + 1];
		const window: Beat = { start: step.timestamp, end: next?.timestamp ?? endMs };
		const idle = idleWithin(window, beats, askWindows);
		const span = Math.max(0, window.end - window.start);
		step.idleMs = idle;
		step.activeMs = Math.max(0, span - idle);
		idleMs += idle;
	}

	const wallMs = Math.max(0, endMs - startMs);
	const activeMs = Math.max(0, wallMs - idleMs);
	const otherMs = Math.max(0, activeMs - modelMs - toolMs);
	const outputTokens = steps.reduce((sum, step) => sum + (step.actual?.output ?? 0), 0);

	return {
		startMs,
		endMs,
		wallMs,
		activeMs,
		idleMs,
		modelMs,
		toolMs,
		otherMs,
		modelCalls: steps.length,
		toolCalls,
		tps: modelMs > 0 && outputTokens > 0 ? outputTokens / (modelMs / 1000) : null,
		estimated: { model: modelEstimated, tool: toolEstimated },
	};
}
