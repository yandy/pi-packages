import { DICT } from "../i18n";
import type { InsightReport } from "../report";
import { type TimelineGeometry, timelineGeometry } from "./timeline";

/** JSON that is safe to inline inside a <script> element. */
export function serializePayload(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export interface InteractivePayload {
	schema: 2;
	mode: "full" | "short";
	lang: string;
	/** Session name or id, used to rebuild the document title on a language switch. */
	sessionTitle: string;
	/** Geometry shared by the server-rendered timeline and the client redraw. */
	geo: TimelineGeometry;
	steps: Array<{
		i: number;
		turn: number;
		stepInTurn: number;
		ts: string;
		sums: Record<string, number>;
		total: number;
		delta: Record<string, number>;
		deltaTotal: number;
		durMs: number;
		activeMs: number;
		prompt: number;
		systemKnown: boolean;
		ev: number[];
		details: boolean;
		ranges: Array<[number, number]>;
	}>;
	items: Array<{
		id: number;
		cat: string;
		kind: string;
		tag: string;
		tok: number;
		body: number | null;
		error?: boolean;
		call?: string;
		truncated?: boolean;
		/** Skill name for skill injections, so a client-rendered row keeps its chip. */
		skill?: string;
		/** Tool source (provider package) for tool definitions. */
		src?: string;
		srcLabel?: string;
		/** ISO timestamp of the item, shown next to its token count. */
		at?: string;
		/** Original length when the body was clipped. */
		len?: number;
	}>;
	tools: Array<{ name: string; source: string; sourceLabel: string }>;
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
		sessionTitle: report.metadata.name ?? `Session ${report.metadata.id}`,
		geo: timelineGeometry(report.steps.length),
		steps: report.steps.map((step) => ({
			i: step.index,
			turn: step.turn,
			stepInTurn: step.stepInTurn,
			ts: new Date(step.timestamp).toISOString(),
			sums: step.sums as unknown as Record<string, number>,
			total: step.estimatedTotal,
			delta: step.delta as unknown as Record<string, number>,
			deltaTotal: step.deltaTotal,
			durMs: step.durationMs ?? 0,
			activeMs: step.activeMs,
			prompt: step.actual?.prompt ?? 0,
			systemKnown: step.system !== null,
			ev: step.eventIds,
			details: step.hasDetails,
			ranges: step.itemRanges,
		})),
		items: report.items.map((item) => {
			const source = item.kind === "toolDefinition" ? report.tools.find((row) => row.name === item.tag) : undefined;
			return {
				id: item.id,
				cat: item.category,
				tag: item.tag,
				kind: item.kind,
				tok: item.tokens,
				body: item.textIndex,
				...(item.isError === true ? { error: true } : {}),
				...(item.toolCallId === undefined ? {} : { call: item.toolCallId }),
				...(item.truncated === true ? { truncated: true, len: item.originalLength ?? 0 } : {}),
				...(item.skillName === undefined ? {} : { skill: item.skillName }),
				...(source === undefined ? {} : { src: source.source, srcLabel: source.sourceLabel }),
				...(item.timestamp === undefined ? {} : { at: new Date(item.timestamp).toISOString() }),
			};
		}),
		tools: report.tools.map((row) => ({ name: row.name, source: row.source, sourceLabel: row.sourceLabel })),
		bodies: report.mode === "short" ? [] : report.bodies,
		events: report.events.map((event) => ({ id: event.id, kind: event.kind, step: event.stepIndex, t: event.timestamp })),
		dicts: { en: DICT.en, zh: DICT.zh },
		truncation: report.truncation,
	};
}

export function buildPayload(report: InsightReport): string {
	return serializePayload(payloadOf(report));
}
