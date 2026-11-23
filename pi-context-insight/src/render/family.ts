import { fmtDuration, fmtTokens } from "../format";
import { t } from "../i18n";
import type { InsightReport } from "../report";
import { esc } from "./escape";
import { chip, microbar, section } from "./layout";

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
			const record = member.record;
			const context = member.child?.context;
			const used = context?.tokens ?? null;
			const window = context?.window ?? 0;
			const occupancy =
				used === null || window <= 0
					? ""
					: `<div style="margin-top:6px">${microbar({ value: used, max: window, tone: "accent", label: `${fmtTokens(used)} / ${fmtTokens(window)}` })}</div>`;
			const headline = used === null ? "—" : `${fmtTokens(used)} / ${window > 0 ? fmtTokens(window) : "—"}`;
			return `<div class="member-card span-4" data-member="${esc(member.id)}" data-status="${member.status}">
<div class="kpi-label">${esc(labelOf(report, member))}</div>
<div class="member-tags">${chip({ text: member.record?.type ?? "?", i18n: undefined })}${chip({ text: t(lang, { key: STATUS_KEY[member.status] ?? member.status }) })}${member.depth > 1 ? chip({ text: `depth ${member.depth}` }) : ""}</div>
<div class="kpi-value">${esc(headline)}</div>
<div class="kpi-sub">${t(lang, { key: "family.meta", params: { steps: member.steps, dur: member.durationMs === undefined ? "—" : fmtDuration(member.durationMs), tokens: fmtTokens(member.usage?.total ?? member.lifetimeTokens ?? 0) } })}</div>
${occupancy}
${record?.modelName === undefined ? "" : `<div class="kpi-sub dim">${esc(record.modelName)}${record.thinking === undefined ? "" : ` · ${esc(record.thinking)}`}</div>`}
</div>`;
		})
		.join("");

	const rows = members
		.map((member) => {
			const record = member.record;
			const brief = report.mode === "short" || member.brief === undefined ? "—" : esc(member.brief);
			const result =
				report.mode === "short"
					? "—"
					: record?.result === undefined
						? record?.error === undefined
							? "—"
							: `<span class="flag">${esc(record.error)}</span>`
						: esc(record.result);
			const briefCell = brief === "—" ? "—" : `<span class="clamp-2" title="${brief}">${brief}</span>`;
			const resultCell =
				result === "—" || result.startsWith("<span") ? result : `<span class="clamp-2" title="${result}">${result}</span>`;
			return `<tr data-delegation="${esc(member.id)}" data-status="${member.status}"><td>${esc(labelOf(report, member))}</td><td>${esc(t(lang, { key: STATUS_KEY[member.status] ?? member.status }))}</td><td>${briefCell}</td><td>${resultCell}</td><td class="num">${fmtTokens(member.usage?.total ?? member.lifetimeTokens ?? 0)}</td><td class="num">${record?.toolUses ?? "—"}</td><td class="dim">${member.durationMs === undefined ? "—" : fmtDuration(member.durationMs)}</td><td class="num">${member.lifetimeCost === undefined ? "—" : fmtCostOf(member.lifetimeCost)}</td></tr>`;
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

	const body = `<div class="member-grid">${cards}</div>
<h3>${t(lang, { key: "family.delegations" })}</h3>
<table><thead><tr><th>${t(lang, { key: "table.agent" })}</th><th>${t(lang, { key: "table.status" })}</th><th>${t(lang, { key: "table.brief" })}</th><th>${t(lang, { key: "table.result" })}</th><th class="num">${t(lang, { key: "table.tokens" })}</th><th class="num">${t(lang, { key: "table.toolUses" })}</th><th>${t(lang, { key: "table.duration" })}</th><th class="num">${t(lang, { key: "table.cost" })}</th></tr></thead><tbody>${rows}</tbody></table>
${untracked}
${children === "" ? "" : `<h3>${t(lang, { key: "family.childReports" })}</h3>${children}`}`;

	return section({ id: "family", titleKey: "family.title", lang, body });
}

function fmtCostOf(value: number): string {
	return `$${(Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(2)).toString()}`;
}
