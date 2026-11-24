import { fmtDuration, fmtShare, fmtTokens } from "../format";
import { t } from "../i18n";
import type { InsightReport } from "../report";
import { stepOutputTps } from "../session/timing";
import { donut } from "./charts";
import { esc } from "./escape";
import { i18nAttrs, legendRow, section } from "./layout";

function formatTps(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} tok/s`;
}

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
			: `<span class="chip" data-tps="1">${esc(formatTps(timing.tps))}</span>`;

	const metrics: Array<{ id: string; labelKey: string; value: string }> = [
		{ id: "activeTps", labelKey: "timing.activeTps", value: formatTps(timing.activeTps) },
		{ id: "latestTps", labelKey: "timing.latestTps", value: formatTps(timing.latestTps) },
		{ id: "medianTps", labelKey: "timing.medianTps", value: formatTps(timing.medianTps) },
		{ id: "fastestTps", labelKey: "timing.fastestTps", value: formatTps(timing.fastestTps) },
		{ id: "slowestTps", labelKey: "timing.slowestTps", value: formatTps(timing.slowestTps) },
		{
			id: "averageModelMs",
			labelKey: "timing.averageModelMs",
			value: timing.averageModelMs === null ? "—" : fmtDuration(timing.averageModelMs),
		},
		{
			id: "p95ModelMs",
			labelKey: "timing.p95ModelMs",
			value: timing.p95ModelMs === null ? "—" : fmtDuration(timing.p95ModelMs),
		},
	];
	const metricGrid = `<div class="throughput-grid">${metrics
		.map(
			(metric) =>
				`<div class="kpi" data-timing-metric="${metric.id}"><div class="kpi-label" ${i18nAttrs(metric.labelKey)}>${esc(t(lang, { key: metric.labelKey }))}</div><div class="kpi-value">${esc(metric.value)}</div></div>`,
		)
		.join("")}</div>`;

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
${metricGrid}
${estimated ? `<p class="dim" style="margin:8px 0 0">${t(lang, { key: "timing.estimatedNote" })}</p>` : ""}
${renderStrip(report)}
${renderRequestThroughput(report)}`;

	return section({ id: "timing", titleKey: "timing.title", lang, span: 6, meta, body });
}

function renderRequestThroughput(report: InsightReport): string {
	const lang = report.lang;
	if (report.steps.length === 0) return "";
	const rows = report.steps
		.map((step) => {
			const output = step.actual === undefined ? "—" : fmtTokens(step.actual.output);
			const duration =
				step.durationMs === undefined
					? "—"
					: `${step.durationEstimated ? "≈" : ""}${fmtDuration(step.durationMs)}`;
			const label = `${t(lang, { key: "label.turn", params: { t: step.turn } })} · ${t(lang, { key: "label.step", params: { s: step.stepInTurn } })}`;
			return `<tr data-request-step="${step.index}"><td>${esc(label)}</td><td class="num">${esc(output)}</td><td class="num">${esc(duration)}</td><td class="num">${esc(formatTps(stepOutputTps(step)))}</td></tr>`;
		})
		.join("");
	return `<details class="request-throughput" data-request-throughput><summary ${i18nAttrs("timing.requests", { count: report.steps.length })}>${esc(t(lang, { key: "timing.requests", params: { count: report.steps.length } }))}</summary>
<div class="scroll-list request-throughput-scroll"><table><thead><tr><th ${i18nAttrs("timing.requestStep")}>${t(lang, { key: "timing.requestStep" })}</th><th class="num" ${i18nAttrs("timing.requestOutput")}>${t(lang, { key: "timing.requestOutput" })}</th><th class="num" ${i18nAttrs("timing.requestModelMs")}>${t(lang, { key: "timing.requestModelMs" })}</th><th class="num" ${i18nAttrs("timing.requestTps")}>${t(lang, { key: "timing.requestTps" })}</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="dim" ${i18nAttrs("timing.requestNote")}>${esc(t(lang, { key: "timing.requestNote" }))}</p></details>`;
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
