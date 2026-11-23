import { fmtDuration, fmtShare } from "../format";
import { t } from "../i18n";
import type { InsightReport } from "../report";
import { esc } from "./escape";

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function renderTimingCard(report: InsightReport): string {
	const lang = report.lang;
	const timing = report.timing;
	const active = Math.max(timing.activeMs, 1);
	const model = Math.min(timing.modelMs, active);
	const tools = Math.min(timing.toolMs, Math.max(0, active - model));
	const other = Math.max(0, active - model - tools);
	const segments = [
		{ id: "model", label: t(lang, { key: "timing.model" }), ms: model, count: timing.modelCalls },
		{ id: "tools", label: t(lang, { key: "timing.tools" }), ms: tools, count: timing.toolCalls },
		{ id: "other", label: t(lang, { key: "timing.other" }), ms: other, count: 0 },
	];

	let offset = 0;
	const arcs = segments
		.filter((segment) => segment.ms > 0)
		.map((segment) => {
			const length = (segment.ms / active) * CIRCUMFERENCE;
			const arc = `<circle r="${RADIUS}" cx="50" cy="50" fill="none" stroke="var(--timing-${segment.id})" stroke-width="12" stroke-dasharray="${length.toFixed(2)} ${(CIRCUMFERENCE - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 50 50)"><title>${esc(segment.label)}</title></circle>`;
			offset += length;
			return arc;
		})
		.join("");

	const rows = segments
		.map(
			(segment) =>
				`<tr data-timing-seg="${segment.id}" class="row"><td><span class="swatch" style="background:var(--timing-${segment.id})"></span>${esc(segment.label)}</td><td class="num">${fmtShare(segment.ms, active)}</td><td class="num">${segment.ms === 0 ? "—" : fmtDuration(segment.ms)}</td><td class="num dim">${segment.count > 0 ? t(lang, { key: "timing.count", params: { count: segment.count } }) : ""}</td></tr>`,
		)
		.join("");

	const estimated = timing.estimated.model || timing.estimated.tool;
	return `<section class="card" id="timing" data-card="timing"><h2>${t(lang, { key: "timing.title" })}
${timing.tps === null ? "" : `<span class="badge" data-tps="1">${t(lang, { key: "timing.tps", params: { tps: timing.tps >= 10 ? Math.round(timing.tps) : timing.tps.toFixed(1) } })}</span>`}</h2>
<div class="grid2"><div style="display:flex;align-items:center;gap:16px"><svg viewBox="0 0 100 100" width="96" height="96" role="img" aria-label="${esc(t(lang, { key: "timing.title" }))}">${arcs}
<text x="50" y="48" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">${esc(fmtDuration(timing.activeMs))}</text>
<text x="50" y="60" text-anchor="middle" fill="var(--dim)" font-size="6">${esc(t(lang, { key: "timing.active" }))}</text></svg>
<div><div class="kpi-label">${t(lang, { key: "timing.wall" })}</div><div class="kpi-value">${fmtDuration(timing.wallMs)}</div>
<div class="kpi-label" style="margin-top:6px">${t(lang, { key: "timing.idle" })}</div><div class="kpi-value">${fmtDuration(timing.idleMs)}</div></div></div>
<div><table><thead><tr><th>${t(lang, { key: "table.segment" })}</th><th class="num">${t(lang, { key: "table.share" })}</th><th class="num">${t(lang, { key: "table.duration" })}</th><th class="num">${t(lang, { key: "table.count" })}</th></tr></thead><tbody>${rows}</tbody></table>
${estimated ? `<p class="dim">${t(lang, { key: "timing.estimatedNote" })}</p>` : ""}</div></div>
${renderStrip(report)}</section>`;
}

function renderStrip(report: InsightReport): string {
	const lang = report.lang;
	const total = report.steps.reduce((sum, step) => sum + Math.max(step.activeMs, 0), 0);
	if (total <= 0) return "";
	const bars = report.steps
		.map((step) => {
			const width = (Math.max(step.activeMs, 0) / total) * 100;
			if (width <= 0) return "";
			return `<i data-step-strip="${step.index}" style="width:${width.toFixed(3)}%;background:var(--timing-model)" title="${esc(`${t(lang, { key: "label.turn", params: { t: step.turn } })} · ${t(lang, { key: "label.step", params: { s: step.stepInTurn } })} · ${fmtDuration(step.activeMs)}`)}"></i>`;
		})
		.join("");
	return `<div style="margin-top:12px"><div class="kpi-label">${t(lang, { key: "timing.strip" })}</div><div class="stack" style="height:10px">${bars}</div></div>`;
}
