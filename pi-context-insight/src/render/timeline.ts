import { fmtTokens } from "../format";
import { t } from "../i18n";
import { CATEGORY_ORDER, type CategoryId } from "../model";
import type { InsightReport } from "../report";
import type { Milestone } from "../session/events";
import { categoryLabel } from "./categories";
import { renderStepDetail } from "./detail";
import { esc } from "./escape";
import { section } from "./layout";

const FLAG_EVERY = 5;
const TIMELINE_MAX = 4000;
const TARGET_WIDTH = 1050;

export interface TimelineGeometry {
	barW: number;
	gap: number;
	flagH: number;
	chartH: number;
	turnH: number;
	height: number;
	axisY: number;
}

/** Bar width adapts to the step count so a short session is not a thin sliver. */
export function timelineGeometry(stepCount: number): TimelineGeometry {
	const steps = Math.max(1, stepCount);
	const barW = Math.max(6, Math.min(24, Math.floor(TARGET_WIDTH / steps)));
	const gap = barW <= 8 ? 1 : 2;
	const flagH = 26;
	const chartH = 150;
	const turnH = 24;
	return { barW, gap, flagH, chartH, turnH, height: 240, axisY: flagH + chartH };
}

function finiteOrZero(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function flagsByStep(report: InsightReport): Map<number, Milestone[]> {
	const map = new Map<number, Milestone[]>();
	for (const milestone of report.milestones) {
		const list = map.get(milestone.stepIndex) ?? [];
		list.push(milestone);
		map.set(milestone.stepIndex, list);
	}
	return map;
}

function barFor(
	report: InsightReport,
	step: { index: number; sums: Record<CategoryId, number>; estimatedTotal: number },
	geo: TimelineGeometry,
	max: number,
	position: number,
): string {
	const x = 10 + position * (geo.barW + geo.gap);
	const scale = max > 0 ? geo.chartH / max : 0;
	const target = Math.round(finiteOrZero(step.estimatedTotal) * scale);
	let y = geo.axisY;
	let remaining = target;
	const segments = CATEGORY_ORDER.filter((id) => id !== "unattributed")
		.filter((id) => (step.sums[id] ?? 0) > 0)
		.map((id, index, list) => {
			const share = step.estimatedTotal > 0 ? (step.sums[id] ?? 0) / step.estimatedTotal : 0;
			const height = index === list.length - 1 ? remaining : Math.min(remaining, Math.round(target * share));
			remaining -= height;
			if (height <= 0) return "";
			y -= height;
			return `<rect x="${x}" y="${y.toFixed(2)}" width="${geo.barW}" height="${height}" fill="var(--${id})"><title>${esc(`${categoryLabel(report.lang, id)} · ≈${fmtTokens(step.sums[id] ?? 0)}`)}</title></rect>`;
		})
		.join("");
	return `<g data-step="${step.index}">${segments}</g>`;
}

export function renderTimeline(report: InsightReport): string {
	return section({
		id: "timeline",
		titleKey: "timeline.title",
		lang: report.lang,
		body: timelineBody(report),
	});
}

/** The timeline card with the selected step's detail folded into its bottom. */
export function renderTimelineSection(report: InsightReport): string {
	return section({
		id: "timeline",
		titleKey: "timeline.title",
		lang: report.lang,
		body: timelineBody(report) + renderStepDetail(report),
	});
}

function timelineBody(report: InsightReport): string {
	const lang = report.lang;
	const steps = report.steps;
	if (steps.length === 0) {
		return `<p class="dim" data-empty="timeline">${t(lang, { key: "empty.timeline" })}</p>`;
	}
	const rendered = steps.length > TIMELINE_MAX ? steps.slice(-TIMELINE_MAX) : steps;
	const geo = timelineGeometry(rendered.length);
	const max = Math.max(1, ...rendered.map((step) => finiteOrZero(step.estimatedTotal)));
	const width = Math.max(320, 20 + rendered.length * (geo.barW + geo.gap));
	const bars = rendered.map((step, position) => barFor(report, step, geo, max, position)).join("");

	const flags = flagsByStep(report);
	const firstIndex = rendered[0]?.index ?? 0;
	const flagBand = [...flags]
		.filter(([stepIndex]) => stepIndex >= firstIndex)
		.map(([stepIndex, milestones]) => {
			const primary = milestones[0];
			if (primary === undefined) return "";
			const x = 10 + Math.min(rendered.length - 1, stepIndex - firstIndex) * (geo.barW + geo.gap) + geo.barW / 2;
			const count = milestones.filter((milestone) => milestone.eventIds.length > 0).length;
			return `<g data-flag="${primary.kind}" data-flag-step="${stepIndex}"><line x1="${x}" x2="${x}" y1="${geo.flagH}" y2="${geo.axisY}" stroke="var(--dim)" stroke-dasharray="2 3" opacity=".45"/><circle cx="${x}" cy="13" r="5" fill="var(--${primary.kind === "compaction" ? "compaction" : "systemSkills"})"><title>${esc(t(lang, { key: `flag.${primary.kind}` }))}</title></circle>${count > 1 ? `<text x="${x}" y="30" text-anchor="middle" font-size="9" fill="var(--text)">+${count - 1}</text>` : ""}</g>`;
		})
		.join("");

	const ticks = [
		{ value: max, y: geo.axisY - geo.chartH },
		{ value: max / 2, y: geo.axisY - geo.chartH / 2 },
		{ value: 0, y: geo.axisY },
	]
		.map(
			(tick) =>
				`<g><line class="grid" x1="0" x2="${width}" y1="${tick.y}" y2="${tick.y}" stroke="var(--line)" stroke-dasharray="2 4"/><text class="tick" x="2" y="${tick.y - 4}" font-size="10" fill="var(--dim)">${esc(fmtTokens(tick.value))}</text></g>`,
		)
		.join("");

	const tickLabels = rendered
		.filter((_step, position) => (position + 1) % FLAG_EVERY === 0)
		.map((_step, position) => {
			const x = 10 + position * (geo.barW + geo.gap) + geo.barW / 2;
			return `<text x="${x}" y="${geo.axisY + geo.turnH + 14}" text-anchor="middle" font-size="9" fill="var(--dim)">S${firstIndex + position + 1}</text>`;
		})
		.join("");

	const turns = report.turns
		.map((turn) => {
			const startPosition = Math.max(0, turn.startStep - firstIndex);
			const endPosition = Math.max(0, turn.endStep - firstIndex);
			const startX = 10 + startPosition * (geo.barW + geo.gap);
			const endX = 10 + Math.min(rendered.length - 1, endPosition) * (geo.barW + geo.gap) + geo.barW;
			const steps = Math.max(1, turn.endStep - turn.startStep + 1);
			return `<g class="row" data-turn-block="${turn.index}"><rect x="${startX}" y="${geo.axisY + 4}" width="${Math.max(geo.barW, endX - startX)}" height="12" fill="${turn.index % 2 === 0 ? "rgba(139,151,168,.14)" : "rgba(139,151,168,.28)"}" rx="2"><title>${esc(t(lang, { key: "timeline.turnBlock", params: { t: turn.index, steps } }))}</title></rect><text x="${startX + 3}" y="${geo.axisY + 13}" font-size="9" fill="var(--text)">${turn.index}</text></g>`;
		})
		.join("");

	const legend = CATEGORY_ORDER.filter((id) => id !== "unattributed")
		.map(
			(id) =>
				`<span data-cat="${id}" data-legend="1"><span class="swatch" style="background:var(--${id})"></span>${esc(categoryLabel(lang, id))}</span>`,
		)
		.join("");

	const toolbar = [
		["mode", "total"],
		["mode", "delta"],
		["granularity", "step"],
		["granularity", "turn"],
		["duration", "duration"],
		["overview", "overview"],
	]
		.map(
			([name, value]) =>
				`<button type="button" data-toggle="${name}" data-value="${value}" aria-pressed="${value === "total" || value === "step"}">${esc(t(lang, { key: `toggle.${value}` }))}</button>`,
		)
		.join("");

	const maxLabel = fmtTokens(max);
	const svg = `<svg data-timeline-svg width="${width}" height="${geo.height}" viewBox="0 0 ${width} ${geo.height}" role="img" aria-label="${esc(t(lang, { key: "timeline.title" }))}" data-geometry="${esc(JSON.stringify(geo))}">
${ticks}
<line x1="0" x2="${width}" y1="${geo.axisY}" y2="${geo.axisY}" stroke="var(--line)"/>
<g data-flag-lane>${flagBand}</g>
${bars}${turns}${tickLabels}
</svg>`;

	return `<div class="toolbar">${toolbar}</div>
<div class="legend">${legend}</div>
<div data-timeline-overview hidden style="margin-top:8px">${steps
		.map(
			(step) =>
				`<i data-overview-step="${step.index}" style="display:inline-block;height:14px;width:${Math.max(1, Math.round((step.estimatedTotal / Math.max(max, 1)) * 60))}px;background:var(--systemBase);margin-right:1px;border-radius:1px" title="${esc(`S${step.index + 1}`)}"></i>`,
		)
		.join("")}</div>
<div class="timeline-scroll" data-timeline-scroll style="margin-top:8px">${svg}</div>
${steps.length > TIMELINE_MAX ? `<p class="dim" data-timeline-cap="${TIMELINE_MAX}">${t(lang, { key: "timeline.capped", params: { total: steps.length, shown: TIMELINE_MAX } })}</p>` : ""}
<p class="dim" style="margin:8px 0 0">${t(lang, { key: "timeline.note", params: { steps: rendered.length, max: maxLabel } })}</p>`;
}
