import { DICT } from "../i18n";
import type { InsightReport } from "../report";

/** JSON that is safe to inline inside a <script> element. */
export function serializePayload(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026");
}

export interface InteractivePayload {
	schema: 2;
	mode: "full" | "short";
	lang: string;
	steps: Array<{
		i: number;
		turn: number;
		sums: Record<string, number>;
		total: number;
		delta: Record<string, number>;
		deltaTotal: number;
		durMs: number;
		activeMs: number;
		ev: number[];
		details: boolean;
	}>;
	items: Array<{ id: number; cat: string; tag: string; tok: number; body: number | null; error?: boolean }>;
	bodies: string[];
	events: Array<{ id: number; kind: string; step: number; t: number }>;
	dicts: Record<string, Record<string, string>>;
	truncation: unknown[];
}

/** The smallest state the browser needs: precomputed numbers plus the item index. */
export function payloadOf(report: InsightReport): InteractivePayload {
	return {
		schema: 2,
		mode: report.mode,
		lang: report.lang,
		steps: report.steps.map((step) => ({
			i: step.index,
			turn: step.turn,
			sums: step.sums as unknown as Record<string, number>,
			total: step.estimatedTotal,
			delta: step.delta as unknown as Record<string, number>,
			deltaTotal: step.deltaTotal,
			durMs: step.durationMs ?? 0,
			activeMs: step.activeMs,
			ev: step.eventIds,
			details: step.hasDetails,
		})),
		items: report.items.map((item) => ({
			id: item.id,
			cat: item.category,
			tag: item.tag,
			tok: item.tokens,
			body: item.textIndex,
			...(item.isError === true ? { error: true } : {}),
		})),
		bodies: report.mode === "short" ? [] : report.bodies,
		events: report.events.map((event) => ({ id: event.id, kind: event.kind, step: event.stepIndex, t: event.timestamp })),
		dicts: { en: DICT.en, zh: DICT.zh },
		truncation: report.truncation,
	};
}

export function buildPayload(report: InsightReport): string {
	return serializePayload(payloadOf(report));
}
