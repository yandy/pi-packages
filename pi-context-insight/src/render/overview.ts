import { fmtCost, fmtDuration, fmtShare, fmtTokens } from "../format";
import { t } from "../i18n";
import type { InsightReport } from "../report";
import { esc } from "./escape";

const USAGE_ROW_LIMIT = 200;

function kpi(label: string, labelKey: string, value: string, sub: string, key: string): string {
	return `<div class="kpi" data-kpi="${key}"><div class="kpi-label" data-i18n="${labelKey}">${esc(label)}</div><div class="kpi-value">${esc(value)}</div><div class="kpi-sub">${sub}</div></div>`;
}

function costBasisKey(report: InsightReport): string {
	return `cost.${report.kpis.costBasis}`;
}

export function renderOverview(report: InsightReport): string {
	const lang = report.lang;
	const k = report.kpis;
	const usage = report.usage;

	const kpis = [
		kpi(
			t(lang, { key: "kpi.tokens" }),
			"kpi.tokens",
			fmtTokens(k.tokens),
			t(lang, { key: "kpi.tokensSub", params: { prompt: fmtTokens(k.prompt), output: fmtTokens(k.output) } }),
			"tokens",
		),
		kpi(t(lang, { key: "kpi.cost" }), "kpi.cost", fmtCost(k.cost), t(lang, { key: costBasisKey(report) }), "cost"),
		kpi(
			t(lang, { key: "kpi.cacheHit" }),
			"kpi.cacheHit",
			k.cacheHitRate === null ? "—" : `${(k.cacheHitRate * 100).toFixed(2)}%`,
			t(lang, {
				key: "kpi.cacheHitSub",
				params: { read: fmtTokens(usage.total.cacheRead), write: fmtTokens(usage.total.cacheWrite) },
			}),
			"cache",
		),
		kpi(
			t(lang, { key: "kpi.calls" }),
			"kpi.calls",
			`${k.modelCalls}`,
			t(lang, { key: "kpi.callsSub", params: { turns: k.turns, tools: k.toolCalls } }),
			"calls",
		),
		kpi(
			t(lang, { key: "kpi.active" }),
			"kpi.active",
			fmtDuration(k.activeMs),
			t(lang, { key: "kpi.activeSub", params: { model: fmtDuration(k.modelMs), tool: fmtDuration(k.toolMs) } }),
			"active",
		),
		kpi(
			t(lang, { key: "kpi.subagents" }),
			"kpi.subagents",
			`${k.subagents}`,
			k.subagents > 0
				? t(lang, {
						key: "kpi.subagentsSub",
						params: { prompt: fmtTokens(k.forwardedPrompt), cost: fmtCost(k.forwardedCost) },
					})
				: "",
			"subagents",
		),
	].join("");

	const modelRows = usage.byModel
		.map(
			(row) =>
				`<tr><td>${esc(row.key)}</td><td class="num">${fmtTokens(row.totals.prompt)}</td><td class="num">${fmtTokens(row.totals.output)}</td><td class="num">${fmtTokens(row.totals.total)}</td><td class="num">${row.totals.cacheHitRate === null ? "—" : `${(row.totals.cacheHitRate * 100).toFixed(1)}%`}</td><td class="num">${fmtCost(row.totals.cost)}</td></tr>`,
		)
		.join("");

	const rows = report.usageRows
		.slice(0, USAGE_ROW_LIMIT)
		.map(
			(row) =>
				`<tr><td>${esc(row.timestamp)}</td><td>${esc(row.source)}</td><td>${esc(row.provider && row.model ? `${row.provider}/${row.model}` : "—")}</td><td class="num">${fmtTokens(row.input + row.cacheRead + row.cacheWrite)}</td><td class="num">${fmtTokens(row.output)}</td><td class="num">${fmtCost(row.cost)}</td></tr>`,
		)
		.join("");
	const omitted =
		report.usageRows.length > USAGE_ROW_LIMIT
			? `<p class="dim">${t(lang, { key: "common.omitted", params: { count: report.usageRows.length - USAGE_ROW_LIMIT } })}</p>`
			: "";

	return `<section class="card" id="overview" data-card="overview"><h2 data-i18n="overview.title">${esc(t(lang, { key: "overview.title" }))}</h2>
<div class="kpis">${kpis}</div>
<div class="grid2" style="margin-top:14px">
<div><h3>${t(lang, { key: "overview.byModel" })}</h3><table><thead><tr><th>${t(lang, { key: "table.model" })}</th><th class="num">prompt</th><th class="num">output</th><th class="num">total</th><th class="num">${t(lang, { key: "table.cacheHit" })}</th><th class="num">${t(lang, { key: "table.cost" })}</th></tr></thead><tbody>${modelRows}</tbody></table></div>
<div><h3>${t(lang, { key: "overview.session" })}</h3><table><tbody>
${report.metadata.name === undefined ? "" : `<tr><th>${t(lang, { key: "table.name" })}</th><td>${esc(report.metadata.name)}</td></tr>`}
<tr><th>${t(lang, { key: "table.id" })}</th><td><code>${esc(report.metadata.id)}</code></td></tr>
<tr><th>${t(lang, { key: "table.cwd" })}</th><td><code>${esc(report.metadata.cwd)}</code></td></tr>
<tr><th>${t(lang, { key: "table.file" })}</th><td><code>${esc(report.metadata.filePath ?? "—")}</code></td></tr>
<tr><th>${t(lang, { key: "table.range" })}</th><td>${esc(report.metadata.startedAt)} → ${esc(report.metadata.endedAt)}</td></tr>
<tr><th>${t(lang, { key: "table.branch" })}</th><td>${t(lang, { key: "overview.branch", params: { branch: report.metadata.branchEntries, total: report.metadata.totalEntries } })}</td></tr>
<tr><th>${t(lang, { key: "table.split" })}</th><td>${t(lang, { key: "overview.split", params: { direct: fmtShare(report.usage.direct.total, report.usage.total.total), forwarded: fmtShare(report.usage.forwardedSubagents.total, report.usage.total.total) } })}</td></tr>
</tbody></table></div></div>
<details style="margin-top:12px"><summary>${t(lang, { key: "overview.usageRows", params: { count: report.usageRows.length } })}</summary>
<table><thead><tr><th>${t(lang, { key: "table.time" })}</th><th>${t(lang, { key: "table.source" })}</th><th>${t(lang, { key: "table.model" })}</th><th class="num">prompt</th><th class="num">output</th><th class="num">${t(lang, { key: "table.cost" })}</th></tr></thead><tbody>${rows}</tbody></table>${omitted}</details>
</section>`;
}
