import { fmtCost, fmtTokens } from "../format";
import { t } from "../i18n";
import { CATEGORY_ORDER, type CategoryId } from "../model";
import type { InsightReport } from "../report";
import { categoryLabel } from "./categories";
import { esc } from "./escape";

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function donut(lang: InsightReport["lang"], total: number, parts: Array<{ id: CategoryId; tokens: number }>): string {
	let offset = 0;
	const arcs = parts
		.filter((part) => part.tokens > 0)
		.map((part) => {
			const fraction = total > 0 ? part.tokens / total : 0;
			const length = fraction * CIRCUMFERENCE;
			const arc = `<circle r="${RADIUS}" cx="50" cy="50" fill="none" stroke="var(--${part.id})" stroke-width="12" stroke-dasharray="${length.toFixed(2)} ${(CIRCUMFERENCE - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 50 50)"><title>${esc(categoryLabel(lang, part.id))}</title></circle>`;
			offset += length;
			return arc;
		})
		.join("");
	return `<svg viewBox="0 0 100 100" width="96" height="96" role="img" aria-label="${esc(t(lang, { key: "tokens.title" }))}">
${arcs}
<text x="50" y="48" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">${esc(fmtTokens(total))}</text>
<text x="50" y="60" text-anchor="middle" fill="var(--dim)" font-size="6">${esc(t(lang, { key: "tokens.centerSub" }))}</text>
</svg>`;
}

export function renderTokens(report: InsightReport): string {
	const lang = report.lang;
	const last = report.steps.at(-1);
	const sums = last?.sums ?? ({} as Record<CategoryId, number>);
	const parts = CATEGORY_ORDER.map((id) => ({ id, tokens: sums[id] ?? 0 }));
	const estimatedTotal = report.steps.at(-1)?.estimatedTotal ?? 0;

	const costByCategory = new Map<CategoryId, number>();
	for (const step of report.steps) {
		for (const [id, value] of Object.entries(step.costByCategory ?? {})) {
			costByCategory.set(id as CategoryId, (costByCategory.get(id as CategoryId) ?? 0) + value);
		}
	}

	const unknown = new Set<CategoryId>(
		report.currentContext.unknownSystem
			? ["systemBase", "systemTools", "systemProject", "systemSkills", "systemDocs", "systemOther", "toolDefinitions"]
			: [],
	);
	const rows = CATEGORY_ORDER.filter((id) => id !== "unattributed" || (sums.unattributed ?? 0) > 0)
		.map((id) => {
			if (unknown.has(id)) {
				return `<tr class="row" data-cat="${id}" data-unknown="system"><td><span class="swatch" style="background:var(--${id})"></span>${esc(categoryLabel(lang, id))}</td><td class="num">—</td><td class="num">—</td><td class="num dim">—</td></tr>`;
			}
			const tokens = sums[id] ?? 0;
			const share = estimatedTotal > 0 ? (tokens / estimatedTotal) * 100 : 0;
			const cost = costByCategory.get(id) ?? 0;
			return `<tr class="row" data-cat="${id}" data-row-kind="category"><td><span class="swatch" style="background:var(--${id})"></span>${esc(categoryLabel(lang, id))}</td><td class="num">≈${fmtTokens(tokens)}</td><td class="num">${share === 0 ? "—" : `${share.toFixed(1)}%`}</td><td class="num dim" title="${esc(t(lang, { key: "tokens.costTip" }))}">${id === "unattributed" ? "—" : fmtCost(cost)}</td></tr>`;
		})
		.join("");

	const cacheHit = report.kpis.cacheHitRate;
	const billed = report.usage.total.total;
	return `<section class="card" id="tokens" data-card="tokens"><h2 data-i18n="tokens.title">${esc(t(lang, { key: "tokens.title" }))}
<span class="badge" data-cache-hit="1">${t(lang, { key: "tokens.cacheHit" })} ${cacheHit === null ? "—" : `${(cacheHit * 100).toFixed(2)}%`}</span></h2>
<div class="grid2"><div style="display:flex;align-items:center;gap:16px">${donut(lang, estimatedTotal, parts)}
<div><div class="kpi-label">${t(lang, { key: "tokens.estimateTotal" })}</div><div class="kpi-value">≈${fmtTokens(estimatedTotal)}</div>
<div class="kpi-label" style="margin-top:6px">${t(lang, { key: "tokens.billed" })}</div><div class="kpi-value" data-billed="1">${fmtTokens(billed)}</div></div></div>
<div><table><thead><tr><th>${t(lang, { key: "table.category" })}</th><th class="num">${t(lang, { key: "table.tokens" })}</th><th class="num">${t(lang, { key: "table.share" })}</th><th class="num">${t(lang, { key: "table.cost" })}</th></tr></thead><tbody>${rows}</tbody></table>
<p class="dim">${t(lang, { key: "tokens.note" })}</p></div></div></section>`;
}
