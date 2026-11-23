import { fmtCost, fmtTokens } from "../format";
import { t } from "../i18n";
import { CATEGORY_ORDER, type CategoryId } from "../model";
import type { InsightReport } from "../report";
import { CATEGORY_LABEL_KEY, categoryLabel } from "./categories";
import { donut } from "./charts";
import { chip, i18nAttrs, legendRow, section } from "./layout";

export function renderTokens(report: InsightReport): string {
	const lang = report.lang;
	const last = report.steps.at(-1);
	const sums = last?.sums ?? ({} as Record<CategoryId, number>);
	const estimatedTotal = last?.estimatedTotal ?? 0;

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
			const label = categoryLabel(lang, id);
			if (unknown.has(id)) {
				return `<div class="legend-row" data-cat="${id}" data-unknown="system"><span class="dot" style="background:var(--${id})"></span><span class="legend-label" ${i18nAttrs(CATEGORY_LABEL_KEY[id])}>${label}</span><span class="legend-value">—</span><span class="legend-share">—</span><span></span></div>`;
			}
			const tokens = sums[id] ?? 0;
			// The residual sits outside the estimate, so a share of it would read as >100%.
			const residual = id === "unattributed";
			const share = !residual && estimatedTotal > 0 ? (tokens / estimatedTotal) * 100 : 0;
			const cost = costByCategory.get(id) ?? 0;
			const tip = id === "unattributed" ? "" : ` title="${t(lang, { key: "tokens.costTip" })} ${fmtCost(cost)}"`;
			return legendRow({
				id,
				label,
				value: `≈${fmtTokens(tokens)}`,
				share: share === 0 ? "—" : `${share.toFixed(1)}%`,
				...(residual ? {} : { bar: { value: tokens, max: estimatedTotal } }),
				i18nKey: CATEGORY_LABEL_KEY[id],
				tip,
			});
		})
		.join("");

	const cacheHit = report.kpis.cacheHitRate;
	const billed = report.usage.total.total;
	const meta = [
		chip({
			text: t(lang, {
				key: "tokens.cacheHitChip",
				params: { p: cacheHit === null ? "—" : (cacheHit * 100).toFixed(2) },
			}),
			i18n: "tokens.cacheHitChip",
			params: { p: cacheHit === null ? "—" : (cacheHit * 100).toFixed(2) },
		}),
		`<span>${t(lang, { key: "cardMeta.donutShare" })}</span>`,
	].join("");

	const parts = CATEGORY_ORDER.filter((id) => !unknown.has(id)).map((id) => ({
		id,
		value: sums[id] ?? 0,
		label: categoryLabel(lang, id),
	}));
	const body = `<div class="donut-pair">
${donut({ total: estimatedTotal, parts, center: `≈${fmtTokens(estimatedTotal)}`, sub: t(lang, { key: "tokens.centerSub" }) })}
<div class="legend-grid">${rows}</div>
</div>
<p class="dim" style="margin:10px 0 0">${t(lang, { key: "tokens.note" })}</p>
<p class="dim" style="margin:4px 0 0"><span data-billed="1">${fmtTokens(billed)}</span> · ${t(lang, { key: "tokens.billed" })}</p>`;

	return section({ id: "tokens", titleKey: "tokens.title", lang, span: 6, meta, body });
}
