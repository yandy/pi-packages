import { fmtDuration, fmtShare } from "../format";
import { t } from "../i18n";
import type { InsightReport } from "../report";
import { donut } from "./charts";
import { esc } from "./escape";
import { legendRow, section } from "./layout";

export function renderTimingCard(report: InsightReport): string {
	const lang = report.lang;
	const timing = report.timing;
	const active = Math.max(timing.activeMs, 1);
	const model = Math.min(timing.modelMs, active);
	const tools = Math.min(timing.toolMs, Math.max(0, active - model));
	const other = Math.max(0, active - model - tools);
	const segments = [
		{ id: "timing-model", label: t(lang, { key: "timing.model" }), ms: model, count: timing.modelCalls },
		{ id: "timing-tools", label: t(lang, { key: "timing.tools" }), ms: tools, count: timing.toolCalls },
		{ id: "timing-other", label: t(lang, { key: "timing.other" }), ms: other, count: 0 },
	];

	const rows = segments
		.map((segment) =>
			legendRow({
				id: segment.id,
				label: segment.label,
				value: segment.ms === 0 ? "—" : fmtDuration(segment.ms),
				share: fmtShare(segment.ms, active),
				bar: { value: segment.ms, max: active },
				seg: segment.id.replace("timing-", ""),
				i18nKey: `timing.${segment.id.replace("timing-", "")}`,
				tip: segment.count > 0 ? ` title="${t(lang, { key: "timing.count", params: { count: segment.count } })}"` : "",
			}),
		)
		.join("");

	const estimated = timing.estimated.model || timing.estimated.tool;
	const meta =
		timing.tps === null
			? ""
			: `<span class="chip" data-tps="1">${esc(
					t(lang, { key: "timing.tps", params: { tps: timing.tps >= 10 ? Math.round(timing.tps) : timing.tps.toFixed(1) } }),
				)}</span>`;

	const facts = `<div class="timing-facts">
<div><div class="kpi-label">${t(lang, { key: "timing.wall" })}</div><div class="kpi-value">${fmtDuration(timing.wallMs)}</div></div>
<div><div class="kpi-label">${t(lang, { key: "timing.idle" })}</div><div class="kpi-value">${fmtDuration(timing.idleMs)}</div></div>
</div>`;

	const body = `<div class="donut-pair">
${donut({
	total: active,
	parts: segments.map((segment) => ({ id: segment.id, value: segment.ms, label: segment.label })),
	center: fmtDuration(timing.activeMs),
	sub: t(lang, { key: "timing.active" }),
})}
<div class="legend-grid">${rows}${facts}</div>
</div>
${estimated ? `<p class="dim" style="margin:8px 0 0">${t(lang, { key: "timing.estimatedNote" })}</p>` : ""}
${renderStrip(report)}`;

	return section({ id: "timing", titleKey: "timing.title", lang, span: 6, meta, body });
}

function renderStrip(report: InsightReport): string {
	const lang = report.lang;
	const total = report.steps.reduce((sum, step) => sum + Math.max(step.activeMs, 0), 0);
	if (total <= 0) return "";
	const bars = report.steps
		.map((step) => {
			const width = (Math.max(step.activeMs, 0) / total) * 100;
			if (width <= 0) return "";
			const label = `${t(lang, { key: "label.turn", params: { t: step.turn } })} · ${t(lang, { key: "label.step", params: { s: step.stepInTurn } })} · ${fmtDuration(step.activeMs)}`;
			return `<i data-step-strip="${step.index}" style="width:${width.toFixed(3)}%" title="${label}"></i>`;
		})
		.join("");
	return `<div style="margin-top:12px"><div class="kpi-label">${t(lang, { key: "timing.strip" })}</div><div class="strip">${bars}</div></div>`;
}
