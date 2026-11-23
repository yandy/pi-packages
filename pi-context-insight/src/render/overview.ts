import { fmtCost, fmtDuration, fmtShare, fmtTokens } from "../format";
import { t } from "../i18n";
import type { InsightReport } from "../report";
import { esc } from "./escape";
import { chip, microbar, section } from "./layout";

const USAGE_ROW_LIMIT = 200;

function kpi(labelKey: string, value: string, sub: string, key: string, lang: InsightReport["lang"]): string {
	return `<div class="kpi" data-kpi="${key}"><div class="kpi-label" data-i18n="${labelKey}">${esc(t(lang, { key: labelKey }))}</div><div class="kpi-value">${esc(value)}</div><div class="kpi-sub">${sub}</div></div>`;
}

export function renderOverview(report: InsightReport): string {
	const lang = report.lang;
	const k = report.kpis;
	const usage = report.usage;

	const kpis = [
		kpi(
			"kpi.tokens",
			fmtTokens(k.tokens),
			t(lang, { key: "kpi.tokensSub", params: { prompt: fmtTokens(k.prompt), output: fmtTokens(k.output) } }),
			"tokens",
			lang,
		),
		kpi(
			"kpi.cost",
			fmtCost(k.cost),
			chip({ text: t(lang, { key: `chip.costBasis.${k.costBasis}` }), i18n: `chip.costBasis.${k.costBasis}` }),
			"cost",
			lang,
		),
		kpi(
			"kpi.cacheHit",
			k.cacheHitRate === null ? "—" : `${(k.cacheHitRate * 100).toFixed(2)}%`,
			t(lang, {
				key: "kpi.cacheHitSub",
				params: { read: fmtTokens(usage.total.cacheRead), write: fmtTokens(usage.total.cacheWrite) },
			}),
			"cache",
			lang,
		),
		kpi(
			"kpi.calls",
			`${k.modelCalls}`,
			t(lang, { key: "kpi.callsSub", params: { turns: k.turns, tools: k.toolCalls } }),
			"calls",
			lang,
		),
		kpi(
			"kpi.active",
			fmtDuration(k.activeMs),
			t(lang, { key: "kpi.activeSub", params: { model: fmtDuration(k.modelMs), tool: fmtDuration(k.toolMs) } }),
			"active",
			lang,
		),
		kpi(
			"kpi.subagents",
			`${k.subagents}`,
			k.subagents > 0
				? t(lang, {
						key: "kpi.subagentsSub",
						params: { prompt: fmtTokens(k.forwardedPrompt), cost: fmtCost(k.forwardedCost) },
					})
				: "",
			"subagents",
			lang,
		),
	].join("");

	const modelMax = Math.max(1, ...usage.byModel.map((row) => row.totals.total));
	const modelRows = usage.byModel
		.map(
			(row) =>
				`<tr><td>${esc(row.key)}</td><td class="num">${fmtTokens(row.totals.prompt)}</td><td class="num">${fmtTokens(row.totals.output)}</td><td class="num">${fmtTokens(row.totals.total)}</td><td class="num">${row.totals.cacheHitRate === null ? "—" : `${(row.totals.cacheHitRate * 100).toFixed(1)}%`}</td><td class="num">${fmtCost(row.totals.cost)}</td><td style="width:96px">${microbar({ value: row.totals.total, max: modelMax, tone: "accent" })}</td></tr>`,
		)
		.join("");

	const facts: Array<[string, string]> = [];
	if (report.metadata.name !== undefined) facts.push(["table.name", esc(report.metadata.name)]);
	facts.push(
		["table.id", `<code>${esc(report.metadata.id)}</code>`],
		["table.cwd", `<code>${esc(report.metadata.cwd)}</code>`],
		["table.file", `<code>${esc(report.metadata.filePath ?? "—")}</code>`],
		["table.range", `${esc(report.metadata.startedAt)} → ${esc(report.metadata.endedAt)}`],
		[
			"table.branch",
			t(lang, {
				key: "overview.branch",
				params: { branch: report.metadata.branchEntries, total: report.metadata.totalEntries },
			}),
		],
		[
			"table.split",
			t(lang, {
				key: "overview.split",
				params: {
					direct: fmtShare(report.usage.direct.total, report.usage.total.total),
					forwarded: fmtShare(report.usage.forwardedSubagents.total, report.usage.total.total),
				},
			}),
		],
	);
	const sessionFacts = `<dl class="kv">${facts
		.map(([key, value]) => `<dt data-i18n="${key}">${esc(t(lang, { key }))}</dt><dd>${value}</dd>`)
		.join("")}</dl>`;

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

	const body = `<div class="kpis">${kpis}</div>
<div class="split">
<div data-block="session"><h3>${t(lang, { key: "overview.session" })}</h3>${sessionFacts}</div>
<div data-block="byModel"><h3>${t(lang, { key: "overview.byModel" })}</h3><table><thead><tr><th>${t(lang, { key: "table.model" })}</th><th class="num">prompt</th><th class="num">output</th><th class="num">total</th><th class="num">${t(lang, { key: "table.cacheHit" })}</th><th class="num">${t(lang, { key: "table.cost" })}</th><th></th></tr></thead><tbody>${modelRows}</tbody></table></div>
</div>
<details><summary>${t(lang, { key: "overview.usageRows", params: { count: report.usageRows.length } })}</summary>
<table><thead><tr><th>${t(lang, { key: "table.time" })}</th><th>${t(lang, { key: "table.source" })}</th><th>${t(lang, { key: "table.model" })}</th><th class="num">prompt</th><th class="num">output</th><th class="num">${t(lang, { key: "table.cost" })}</th></tr></thead><tbody>${rows}</tbody></table>${omitted}</details>`;

	return section({ id: "overview", titleKey: "overview.title", lang, body });
}
