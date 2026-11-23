import { fmtShare, fmtTokens } from "../format";
import { t } from "../i18n";
import { CATEGORY_ORDER } from "../model";
import type { InsightReport } from "../report";
import { categoryLabel } from "./categories";
import { esc } from "./escape";

function finite(value: number, fallback = 0): number {
	return Number.isFinite(value) ? value : fallback;
}

export function renderCurrentContext(report: InsightReport): string {
	const lang = report.lang;
	const context = report.currentContext;
	const window = Math.max(0, finite(context.window));
	const used = Math.max(0, finite(context.tokens ?? 0));
	const scale = Math.max(window, used, 1);
	const occupied = Math.min(used, scale) / scale;

	const safe = (value: number | undefined): number =>
		typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
	const reserveTokens = safe(context.reserveTokens);
	const maxTokens = safe(context.maxTokens);
	const segments = CATEGORY_ORDER.filter((id) => safe(context.categories[id]) > 0)
		.map((id) => {
			const tokens = safe(context.categories[id]);
			const width = (tokens / scale) * 100;
			return `<i style="width:${width.toFixed(3)}%;background:var(--${id})" title="${esc(`${categoryLabel(lang, id)} · ≈${fmtTokens(tokens)} · ${fmtShare(tokens, used)}`)}" data-cat="${id}"></i>`;
		})
		.join("");

	const free = Math.max(0, 1 - occupied - (context.reserveEnabled ? reserveTokens / scale : 0) - maxTokens / scale);
	const reserve = context.reserveEnabled
		? `<i class="hatch" data-reserve="headroom" style="width:${((reserveTokens / scale) * 100).toFixed(3)}%" title="${esc(t(lang, { key: "context.headroom", params: { p: ((reserveTokens / scale) * 100).toFixed(1) } }))}"></i>`
		: "";
	const output =
		maxTokens > 0
			? `<i class="hatch-out" data-reserve="output" style="width:${((maxTokens / scale) * 100).toFixed(3)}%" title="${esc(t(lang, { key: "context.output" }))}"></i>`
			: "";
	const freeBar =
		free > 0 ? `<i style="width:${(free * 100).toFixed(3)}%" title="${esc(t(lang, { key: "context.free" }))}"></i>` : "";
	const triggerAt = context.reserveEnabled ? Math.max(0, 1 - reserveTokens / scale) : null;
	const trigger =
		triggerAt === null
			? ""
			: `<span data-trigger="1" style="position:absolute;left:${(triggerAt * 100).toFixed(3)}%;top:-2px;bottom:-2px;border-left:1px dashed var(--warn)" title="${esc(t(lang, { key: "context.trigger", params: { tokens: fmtTokens(window - reserveTokens) } }))}"></span>`;

	const legend = CATEGORY_ORDER.filter((id) => safe(context.categories[id]) > 0)
		.map(
			(id) =>
				`<span class="row" data-cat="${id}" data-legend="1"><span class="swatch" style="background:var(--${id})"></span>${esc(categoryLabel(lang, id))} ≈${fmtTokens(safe(context.categories[id]))} · ${fmtShare(safe(context.categories[id]), used)}</span>`,
		)
		.join("");

	const percentText =
		context.percent === null || !Number.isFinite(context.percent) ? "—" : `${context.percent.toFixed(1)}%`;
	const headline = `${context.estimated ? "≈" : ""}${fmtTokens(used)} / ${fmtTokens(window)} · ${percentText}`;
	const disabled = !context.reserveEnabled ? `<p class="dim">${t(lang, { key: "context.compactionDisabled" })}</p>` : "";

	return `<section class="card" id="context" data-card="context"><h2 data-i18n="context.title">${esc(t(lang, { key: "context.title" }))}<span class="dim" style="font-weight:400"> ${esc(report.metadata.model ?? "")} ${esc(report.metadata.thinkingLevel ?? "")}</span></h2>
<div class="kpi-value" data-occupancy="1">${headline}</div>
<div style="position:relative;margin-top:10px"><div class="stack">${segments}${reserve}${output}${freeBar}</div>${trigger}</div>
<div class="legend">${legend}</div>
${disabled}
<p class="dim">${t(lang, { key: "context.note" })}</p></section>`;
}
