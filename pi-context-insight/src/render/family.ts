import { fmtDuration, fmtTokens } from "../format";
import { t } from "../i18n";
import type { InsightReport } from "../report";
import { esc } from "./escape";

function labelOf(report: InsightReport, member: { id: string; record?: { description: string } }): string {
	if (report.mode === "short") return member.id;
	const description = member.record?.description ?? "";
	return description.length > 0 ? description : member.id;
}

const STATUS_KEY: Record<string, string> = {
	completed: "family.status.completed",
	error: "family.status.error",
	stopped: "family.status.stopped",
	aborted: "family.status.aborted",
	untracked: "family.status.untracked",
};

export function renderFamily(report: InsightReport): string {
	const lang = report.lang;
	const members = report.family.members;
	if (members.length === 0) return "";

	const cards = members
		.map((member) => {
			const records = member.record;
			return `<div class="kpi" data-member="${esc(member.id)}" data-status="${member.status}" style="grid-column:span 2">
<div class="kpi-label">${esc(labelOf(report, member))} <span class="tag">${esc(member.record?.type ?? "?")}</span> <span class="tag">${esc(t(lang, { key: STATUS_KEY[member.status] ?? member.status }))}</span>${member.depth > 1 ? ` <span class="tag">depth ${member.depth}</span>` : ""}</div>
<div class="kpi-value">${member.child?.context === undefined || member.child.context.tokens === null ? "—" : `${fmtTokens(member.child.context.tokens)} / ${fmtTokens(member.child.context.window)}`}</div>
<div class="kpi-sub">${t(lang, { key: "family.meta", params: { steps: member.steps, dur: member.durationMs === undefined ? "—" : fmtDuration(member.durationMs), tokens: fmtTokens(member.usage?.total ?? 0) } })}</div>
${records?.modelName === undefined ? "" : `<div class="kpi-sub dim">${esc(records.modelName)}${records.thinking === undefined ? "" : ` · ${esc(records.thinking)}`}</div>`}
</div>`;
		})
		.join("");

	const rows = members
		.map((member) => {
			const record = member.record;
			return `<tr class="row" data-delegation="${esc(member.id)}" data-status="${member.status}"><td>${esc(labelOf(report, member))}</td><td>${esc(t(lang, { key: STATUS_KEY[member.status] ?? member.status }))}</td><td>${report.mode === "short" || member.brief === undefined ? "—" : esc(member.brief)}</td><td>${report.mode === "short" ? "—" : record?.result === undefined ? (record?.error === undefined ? "—" : `<span class="flag">${esc(record.error)}</span>`) : esc(record.result)}</td><td class="num">${fmtTokens(member.usage?.total ?? 0)}</td><td class="num">${record?.toolUses ?? "—"}</td><td class="dim">${member.durationMs === undefined ? "—" : fmtDuration(member.durationMs)}</td></tr>`;
		})
		.join("");

	const untracked = members.some((member) => member.status === "untracked")
		? `<p class="dim">${t(lang, { key: "family.untrackedNote" })}</p>`
		: "";

	const children = report.family.children
		.map(
			(child) =>
				`<details data-child-report="${esc(child.member.id)}"><summary>${esc(labelOf(report, child.member))} · ${fmtTokens(child.report.kpis.tokens)} tokens · ${fmtCostOf(child.report.kpis.cost)}</summary>
<p class="dim">${t(lang, { key: "family.childScope" })}</p>
<table><tbody>
<tr><th>${t(lang, { key: "table.tokens" })}</th><td>${fmtTokens(child.report.kpis.tokens)}</td></tr>
<tr><th>${t(lang, { key: "kpi.calls" })}</th><td>${child.report.kpis.modelCalls}</td></tr>
<tr><th>${t(lang, { key: "kpi.active" })}</th><td>${fmtDuration(child.report.kpis.activeMs)}</td></tr>
</tbody></table></details>`,
		)
		.join("");

	return `<section class="card" id="family" data-card="family"><h2>${t(lang, { key: "family.title" })}</h2>
<div class="kpis">${cards}</div>
<h3 style="margin-top:14px">${t(lang, { key: "family.delegations" })}</h3>
<table><thead><tr><th>${t(lang, { key: "table.agent" })}</th><th>${t(lang, { key: "table.status" })}</th><th>${t(lang, { key: "table.brief" })}</th><th>${t(lang, { key: "table.result" })}</th><th class="num">${t(lang, { key: "table.tokens" })}</th><th class="num">${t(lang, { key: "table.toolUses" })}</th><th>${t(lang, { key: "table.duration" })}</th></tr></thead><tbody>${rows}</tbody></table>
${untracked}
${children === "" ? "" : `<h3 style="margin-top:14px">${t(lang, { key: "family.childReports" })}</h3>${children}`}</section>`;
}

function fmtCostOf(value: number): string {
	return `$${(Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(2)).toString()}`;
}
