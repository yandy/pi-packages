import { fmtClock, fmtCost, fmtDuration, fmtTokens } from "../format";
import { t } from "../i18n";
import type { InsightReport } from "../report";
import type { BriefChip } from "../session/steps";
import { esc } from "./escape";

function chip(brief: BriefChip, locatable: boolean): string {
	const attrs = locatable ? ` data-locate-item="${brief.itemId}"` : "";
	return `<span class="tag"${attrs} title="${esc(brief.preview)}">${esc(brief.tag)}</span>`;
}

export function renderStepDetail(report: InsightReport): string {
	const lang = report.lang;
	if (report.steps.length === 0) return "";
	const panels = report.steps
		.map((step) => {
			const hidden = step.index === report.steps.length - 1 ? "" : " hidden";
			const inputs =
				step.brief.inputs.length > 0
					? step.brief.inputs.map((brief) => chip(brief, step.hasDetails)).join("")
					: `<span class="dim">${t(lang, { key: "detail.noInputs" })}</span>`;
			const replies =
				step.brief.replies.length > 0
					? step.brief.replies.map((brief) => chip(brief, step.hasDetails)).join("")
					: `<span class="dim">${t(lang, { key: "detail.noReplies" })}</span>`;
			const user = step.brief.user ? chip(step.brief.user, step.hasDetails) : `<span class="dim">—</span>`;
			const actual =
				step.actual === undefined
					? `<span class="dim">${t(lang, { key: "detail.noUsage" })}</span>`
					: `${t(lang, { key: "detail.actual", params: { tokens: fmtTokens(step.actual.prompt) } })} · ${t(lang, { key: "detail.output", params: { tokens: fmtTokens(step.actual.output) } })} · ${t(lang, { key: "detail.cache", params: { p: step.actual.prompt > 0 ? ((step.actual.cacheRead / step.actual.prompt) * 100).toFixed(2) : "—" } })}`;
			const cost = step.actual === undefined ? "" : ` · ${fmtCost(step.actual.cost)}`;
			return `<div data-step-panel="${step.index}"${hidden}>
<div class="row"><strong>${esc(t(lang, { key: "detail.title", params: { t: step.turn, s: step.stepInTurn } }))}</strong>
<span class="dim">${fmtClock(step.timestamp)} · ${fmtDuration(step.durationMs ?? 0)} · ≈${fmtTokens(step.estimatedTotal)}${step.deltaTotal === 0 ? "" : ` · Δ${step.deltaTotal > 0 ? "+" : ""}${fmtTokens(step.deltaTotal)}`}${cost}</span></div>
<table><tbody>
<tr><th style="width:70px">${t(lang, { key: "detail.user" })}</th><td>${user}</td></tr>
<tr><th>${t(lang, { key: "detail.inputs" })}</th><td>${inputs}</td></tr>
<tr><th>${t(lang, { key: "detail.replies" })}</th><td>${replies}</td></tr>
<tr><th>${t(lang, { key: "detail.actualLabel" })}</th><td>${actual}</td></tr>
</tbody></table></div>`;
		})
		.join("");
	return `<div class="card" data-card="detail" style="margin-top:-8px"><div style="max-height:280px;overflow:auto">${panels}</div></div>`;
}
