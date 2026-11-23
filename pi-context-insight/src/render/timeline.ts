import { fmtTokens } from "../format";
import { t } from "../i18n";
import { CATEGORY_ORDER, type CategoryId } from "../model";
import type { InsightReport } from "../report";
import type { Milestone } from "../session/events";
import { categoryLabel } from "./categories";
import { esc } from "./escape";

const BAR_W = 14;
const BAR_GAP = 2;
const CHART_H = 112;
const FLAG_EVERY = 5;
const TIMELINE_MAX = 4000;

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
	max: number,
	position: number,
): string {
	const x = 10 + position * (BAR_W + BAR_GAP);
	const scale = max > 0 ? CHART_H / max : 0;
	const target = Math.round(finiteOrZero(step.estimatedTotal) * scale);
	let y = 150;
	let remaining = target;
	const segments = CATEGORY_ORDER.filter((id) => id !== "unattributed")
		.filter((id) => (step.sums[id] ?? 0) > 0)
		.map((id, index, list) => {
			const share = step.estimatedTotal > 0 ? (step.sums[id] ?? 0) / step.estimatedTotal : 0;
			const height = index === list.length - 1 ? remaining : Math.min(remaining, Math.round(target * share));
			remaining -= height;
			if (height <= 0) return "";
			y -= height;
			return `<rect x="${x}" y="${y.toFixed(2)}" width="${BAR_W}" height="${height}" fill="var(--${id})"><title>${esc(`${categoryLabel(report.lang, id)} · ≈${fmtTokens(step.sums[id] ?? 0)}`)}</title></rect>`;
		})
		.join("");
	return `<g data-step="${step.index}">${segments}</g>`;
}

export function renderTimeline(report: InsightReport): string {
	const lang = report.lang;
	const steps = report.steps;
	if (steps.length === 0) {
		return `<section class="card" id="timeline" data-card="timeline"><h2 data-i18n="timeline.title">${esc(t(lang, { key: "timeline.title" }))}</h2><p class="dim" data-empty="timeline">${t(lang, { key: "empty.timeline" })}</p></section>`;
	}
	const all = steps;
	const rendered = steps.length > TIMELINE_MAX ? steps.slice(-TIMELINE_MAX) : steps;
	const max = Math.max(1, ...rendered.map((step) => finiteOrZero(step.estimatedTotal)));
	const width = Math.max(720, rendered.length * (BAR_W + BAR_GAP) + 20);
	const bars = rendered.map((step, position) => barFor(report, step, max, position)).join("");
	const flags = flagsByStep(report);
	const firstIndex = rendered[0]?.index ?? 0;
	const flagBand = [...flags]
		.filter(([stepIndex]) => stepIndex >= firstIndex)
		.map(([stepIndex, milestones]) => {
			const primary = milestones[0];
			if (primary === undefined) return "";
			const x = 10 + (stepIndex - firstIndex) * (BAR_W + BAR_GAP) + BAR_W / 2;
			const count = milestones.filter((milestone) => milestone.eventIds.length > 0).length;
			return `<g data-flag="${primary.kind}" data-flag-step="${stepIndex}"><line x1="${x}" x2="${x}" y1="18" y2="150" stroke="var(--dim)" stroke-dasharray="2 3" opacity=".5"/><circle cx="${x}" cy="18" r="5" fill="var(--${primary.kind === "compaction" ? "compaction" : "systemSkills"})"><title>${esc(t(lang, { key: `flag.${primary.kind}` }))}</title></circle>${count > 1 ? `<text x="${x}" y="36" text-anchor="middle" font-size="8" fill="var(--text)">+${count - 1}</text>` : ""}</g>`;
		})
		.join("");
	const tickLabels = rendered
		.filter((step) => (step.index + 1) % FLAG_EVERY === 0)
		.map((_step, position) => {
			const x = 10 + position * (BAR_W + BAR_GAP) + BAR_W / 2;
			return `<text x="${x}" y="166" text-anchor="middle" font-size="8" fill="var(--dim)">S${firstIndex + position + 1}</text>`;
		})
		.join("");
	const turns = report.turns
		.map((turn) => {
			const startX = 10 + Math.max(0, turn.startStep - firstIndex) * (BAR_W + BAR_GAP);
			const endX = 10 + Math.max(turn.startStep, turn.endStep - firstIndex) * (BAR_W + BAR_GAP) + BAR_W;
			return `<g class="row" data-turn-block="${turn.index}"><rect x="${startX}" y="172" width="${Math.max(BAR_W, endX - startX)}" height="12" fill="${turn.index % 2 === 0 ? "rgba(147,161,184,.14)" : "rgba(147,161,184,.28)"}" rx="2"><title>${esc(t(lang, { key: "timeline.turnBlock", params: { t: turn.index, steps: turn.endStep - turn.startStep + 1 } }))}</title></rect><text x="${startX + 3}" y="181" font-size="8" fill="var(--text)">${turn.index}</text></g>`;
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
		["adaptive", "adaptive"],
		["duration", "duration"],
		["overview", "overview"],
		["dna", "dna"],
	]
		.map(
			([name, value], index) =>
				`<button type="button" data-toggle="${name}" data-value="${value}" aria-pressed="${index === 0 || index === 2 || index === 4 || index === 5}">${esc(t(lang, { key: `toggle.${value}` }))}</button>`,
		)
		.join("");

	const maxLabel = fmtTokens(max);
	return `<section class="card" id="timeline" data-card="timeline"><h2 data-i18n="timeline.title">${esc(t(lang, { key: "timeline.title" }))}</h2>
<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">${toolbar}</div>
<div class="legend">${legend}</div>
<div data-timeline-overview hidden style="margin-top:8px">${steps
		.map(
			(step) =>
				`<i data-overview-step="${step.index}" style="display:inline-block;height:14px;width:${Math.max(1, Math.round((step.estimatedTotal / Math.max(max, 1)) * 60))}px;background:var(--systemBase);margin-right:1px;border-radius:1px" title="${esc(`S${step.index + 1}`)}"></i>`,
		)
		.join("")}</div>
<div class="timeline-scroll" data-timeline-scroll style="margin-top:8px"><svg width="${width}" height="190" viewBox="0 0 ${width} 190" role="img" aria-label="${esc(t(lang, { key: "timeline.title" }))}">
<line x1="10" x2="${width - 10}" y1="150" y2="150" stroke="var(--line)"/>
<text x="10" y="10" font-size="8" fill="var(--dim)">${esc(maxLabel)}</text>
<text x="10" y="126" font-size="8" fill="var(--dim)">${esc(fmtTokens(max / 4))}</text>
<text x="10" y="94" font-size="8" fill="var(--dim)">${esc(fmtTokens(max / 2))}</text>
<text x="10" y="62" font-size="8" fill="var(--dim)">${esc(fmtTokens((max * 3) / 4))}</text>
${bars}${flagBand}${tickLabels}${turns}
</svg></div>
${all.length > TIMELINE_MAX ? `<p class="dim" data-timeline-cap="${TIMELINE_MAX}">${t(lang, { key: "timeline.capped", params: { total: all.length, shown: TIMELINE_MAX } })}</p>` : ""}
<p class="dim">${t(lang, { key: "timeline.note", params: { steps: rendered.length, max: maxLabel } })}</p></section>`;
}
