import { fmtShare, fmtTokens } from "../format";
import { t } from "../i18n";
import { CATEGORY_ORDER } from "../model";
import type { InsightReport } from "../report";
import { CATEGORY_LABEL_KEY, categoryLabel } from "./categories";
import { stackBar } from "./charts";
import { esc } from "./escape";
import { i18nAttrs, section } from "./layout";

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
	const present = CATEGORY_ORDER.filter((id) => safe(context.categories[id]) > 0);

	const segments = [
		...present.map((id) => ({
			id,
			pct: (safe(context.categories[id]) / scale) * 100,
			title: `${categoryLabel(lang, id)} · ≈${fmtTokens(safe(context.categories[id]))} · ${fmtShare(safe(context.categories[id]), used)}`,
		})),
		...(context.reserveEnabled
			? [
					{
						id: "compaction",
						pct: (reserveTokens / scale) * 100,
						title: t(lang, { key: "context.headroom", params: { p: ((reserveTokens / scale) * 100).toFixed(1) } }),
						cls: "hatch",
					},
				]
			: []),
		...(maxTokens > 0
			? [
					{
						id: "toolDefinitions",
						pct: (maxTokens / scale) * 100,
						title: t(lang, { key: "context.output" }),
						cls: "hatch-out",
					},
				]
			: []),
		...(Math.max(0, 1 - occupied - (context.reserveEnabled ? reserveTokens / scale : 0) - maxTokens / scale) > 0
			? [
					{
						id: "",
						pct: Math.max(0, 1 - occupied - (context.reserveEnabled ? reserveTokens / scale : 0) - maxTokens / scale) * 100,
						title: t(lang, { key: "context.free" }),
					},
				]
			: []),
	];

	const triggerAt = context.reserveEnabled ? Math.max(0, 1 - reserveTokens / scale) : null;
	const trigger =
		triggerAt === null
			? ""
			: `<span data-trigger="1" style="position:absolute;left:${(triggerAt * 100).toFixed(3)}%;top:-4px;bottom:-4px;border-left:1px dashed var(--warn)" title="${esc(t(lang, { key: "context.trigger", params: { tokens: fmtTokens(window - reserveTokens) } }))}"></span>`;

	const legend = present
		.map(
			(id) =>
				`<span class="row" data-cat="${id}" data-legend="1"><span class="dot" style="background:var(--${id})"></span><span ${i18nAttrs(CATEGORY_LABEL_KEY[id])}>${esc(categoryLabel(lang, id))}</span> <span class="dim">≈${fmtTokens(safe(context.categories[id]))} · ${fmtShare(safe(context.categories[id]), used)}</span></span>`,
		)
		.join("");

	const reserveChips = [
		context.reserveEnabled
			? `<span class="chip" data-reserve="headroom"><span class="swatch hatch" style="margin-right:4px"></span>${esc(t(lang, { key: "context.headroom", params: { p: ((reserveTokens / scale) * 100).toFixed(1) } }))}</span>`
			: "",
		maxTokens > 0
			? `<span class="chip" data-reserve="output"><span class="swatch hatch-out" style="margin-right:4px"></span>${esc(t(lang, { key: "context.output" }))}</span>`
			: "",
	]
		.filter((part) => part !== "")
		.join("");

	const percentText =
		context.percent === null || !Number.isFinite(context.percent) ? "—" : `${context.percent.toFixed(1)}%`;
	const headline = `${context.estimated ? "≈" : ""}${fmtTokens(used)} / ${fmtTokens(window)}`;
	const disabled = !context.reserveEnabled ? `<p class="dim">${t(lang, { key: "context.compactionDisabled" })}</p>` : "";

	const body = `<div class="occupancy-row"><div><div class="occupancy" data-occupancy="1">${esc(headline)}</div><div class="dim">${esc(t(lang, { key: "context.title" }))}</div></div><div class="occupancy-share">${esc(percentText)}</div></div>
<div style="position:relative;margin-top:10px">${stackBar({ segments, height: 22, ariaLabel: headline })}${trigger}</div>
<div class="legend legend-3">${legend}</div>
${reserveChips === "" ? "" : `<div class="legend">${reserveChips}</div>`}
${disabled}
<p class="dim" style="margin:8px 0 0">${t(lang, { key: "context.note" })}</p>`;

	return section({ id: "context", titleKey: "context.title", lang, body });
}
