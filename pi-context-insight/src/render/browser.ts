import { fmtClock, fmtTokens } from "../format";
import { t } from "../i18n";
import type { CategoryId } from "../model";
import type { InsightReport } from "../report";
import type { Item } from "../session/categorize";
import type { Step } from "../session/steps";
import { categoryLabel } from "./categories";
import { esc } from "./escape";

const ROW_LIMIT = 200;
const STEP_PICK_MAX = 500;

const GROUP_OF: Record<CategoryId, CategoryId> = {
	systemBase: "systemBase",
	systemTools: "systemBase",
	systemProject: "systemBase",
	systemSkills: "systemBase",
	systemDocs: "systemBase",
	systemOther: "systemBase",
	toolDefinitions: "toolDefinitions",
	user: "user",
	injected: "injected",
	skillInjections: "skillInjections",
	compaction: "compaction",
	reasoning: "answers",
	answers: "answers",
	toolCalls: "toolCalls",
	toolResults: "toolResults",
	unattributed: "unattributed",
};

const GROUP_LABEL_KEY: Record<string, string> = {
	systemBase: "browser.system",
	toolDefinitions: "cat.toolDefinitions",
	user: "cat.user",
	injected: "cat.injected",
	skillInjections: "cat.skillInjections",
	compaction: "cat.compaction",
	answers: "cat.answers",
	toolCalls: "cat.toolCalls",
	toolResults: "cat.toolResults",
	unattributed: "cat.unattributed",
};

const GROUPS: readonly CategoryId[] = [
	"systemBase",
	"toolDefinitions",
	"user",
	"injected",
	"skillInjections",
	"compaction",
	"answers",
	"toolCalls",
	"toolResults",
	"unattributed",
];

function rangeHas(ranges: ReadonlyArray<[number, number]>, id: number): boolean {
	return ranges.some(([start, end]) => id >= start && id <= end);
}

function itemsOfStep(report: InsightReport, step: Step): Item[] {
	return report.items.filter((item) => rangeHas(step.itemRanges, item.id));
}

function preview(report: InsightReport, item: Item): string {
	if (item.textIndex === null) return "";
	const text = report.bodies[item.textIndex] ?? "";
	return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

function toolSource(report: InsightReport, tag: string): { source: string; label: string } | undefined {
	const tool = report.tools.find((row) => row.name === tag);
	if (tool === undefined) return undefined;
	return { source: tool.source, label: tool.sourceLabel };
}

function rowHtml(report: InsightReport, item: Item): string {
	const lang = report.lang;
	const source = item.kind === "toolDefinition" ? toolSource(report, item.tag) : undefined;
	const chips = [
		item.kind === "toolResult" || item.block === "toolCall" ? `<span class="tag">${esc(item.tag)}</span>` : "",
		item.skillName === undefined
			? ""
			: `<span class="tag">${esc(t(lang, { key: "browser.skillTag", params: { name: item.skillName } }))}</span>`,
		item.isError === true ? `<span class="flag">✕</span>` : "",
		source === undefined
			? ""
			: `<span class="tag" data-tool-source="${source.source}">${esc(source.label || source.source)}</span>`,
	].join("");
	const kindAttr = item.block === undefined ? "" : ` data-kind="${item.block}"`;
	const search = `${item.tag} ${preview(report, item)}`.toLowerCase();
	const body =
		item.textIndex === null || report.mode === "short"
			? `<p class="dim" data-empty="browser-body">${t(lang, { key: "empty.shortNoBody" })}</p>`
			: `<pre class="body">${esc(report.bodies[item.textIndex] ?? "")}</pre>`;
	const clock = item.timestamp === undefined ? "—" : fmtClock(item.timestamp);
	return `<details class="row" data-item="${item.id}" data-cat="${item.category}"${kindAttr} data-search="${esc(search)}"><summary><span class="tag">${esc(categoryLabel(lang, item.category))}</span>${chips}<span class="dim">${esc(preview(report, item))}</span> <span class="dim">≈${fmtTokens(item.tokens)} · ${esc(clock)}</span>${item.truncated === true ? ` <span class="flag">${esc(t(lang, { key: "browser.truncated", params: { chars: item.originalLength ?? 0 } }))}</span>` : ""}</summary>${body}</details>`;
}

function categoryRow(report: InsightReport, step: Step, group: CategoryId): string {
	const list = itemsOfStep(report, step).filter((item) => GROUP_OF[item.category] === group);
	const tokens = list.reduce((sum, item) => sum + item.tokens, 0);
	const share = step.estimatedTotal > 0 ? (tokens / step.estimatedTotal) * 100 : 0;
	const delta = step.delta[group] ?? 0;
	const badge =
		delta === 0 ? "" : `<span class="tag" data-delta="${group}">${delta > 0 ? "+" : ""}${fmtTokens(delta)}</span>`;
	return `<tr class="row" data-cat-row="${group}" data-count="${list.length}"><td><span class="swatch" style="background:var(--${group})"></span>${esc(t(report.lang, { key: GROUP_LABEL_KEY[group] ?? group }))}</td><td class="num">${list.length}</td><td class="num">≈${fmtTokens(tokens)}</td><td class="num">${share === 0 ? "—" : `${share.toFixed(1)}%`}</td><td class="num">${badge}</td></tr>`;
}

function panelOf(report: InsightReport, step: Step, selected: boolean): string {
	const lang = report.lang;
	const items = itemsOfStep(report, step);
	const groups = GROUPS.map((group) => {
		const all = items.filter((item) => GROUP_OF[item.category] === group);
		if (all.length === 0) return "";
		const list = all.slice(0, ROW_LIMIT);
		const rest = all.slice(ROW_LIMIT, ROW_LIMIT * 10);
		const rows = list.map((item) => rowHtml(report, item)).join("");
		const more =
			rest.length > 0
				? `<details data-more="${group}"><summary>${t(lang, { key: "common.omitted", params: { count: rest.length } })}</summary>${rest.map((item) => rowHtml(report, item)).join("")}</details>`
				: "";
		return `<h4 data-cat-section="${group}">${esc(t(lang, { key: GROUP_LABEL_KEY[group] ?? group }))}</h4>${rows}${more}`;
	}).join("");
	const empty =
		items.length === 0
			? `<p class="dim" data-empty="browser">${step.hasDetails ? t(lang, { key: "empty.browserStep" }) : t(lang, { key: "empty.browserWindow" })}</p>`
			: "";
	return `<div data-browser-panel="${step.index}"${selected ? "" : " hidden"}><p class="dim">${t(lang, { key: "browser.stepMeta", params: { t: step.turn, s: step.stepInTurn, total: fmtTokens(step.estimatedTotal), actual: step.actual === undefined ? "—" : fmtTokens(step.actual.prompt) } })}</p>${empty}${groups}</div>`;
}

function dnaList(report: InsightReport, step: Step): string {
	const lang = report.lang;
	const items = itemsOfStep(report, step).slice().reverse();
	const rows = items
		.map(
			(item, index) =>
				`<div class="row" data-dna-item="${item.id}"><span class="tag" style="border-color:var(--${item.category})">${esc(categoryLabel(lang, item.category))}</span><span class="dim">#${items.length - index}</span> ${esc(item.tag)} <span class="dim">≈${fmtTokens(item.tokens)}</span></div>`,
		)
		.join("");
	return `<div data-dna-list>${rows || `<p class="dim">${t(lang, { key: "empty.none" })}</p>`}</div>`;
}

export function renderBrowser(report: InsightReport): string {
	const lang = report.lang;
	const steps = report.steps;
	if (steps.length === 0) {
		return `<section class="card" id="browser" data-card="browser"><h2 data-i18n="browser.title">${esc(t(lang, { key: "browser.title" }))}</h2><p class="dim" data-empty="browser">${t(lang, { key: "empty.browserStep" })}</p></section>`;
	}
	const recent = steps.slice(-STEP_PICK_MAX);
	const withEvents = steps.filter((step) => step.eventIds.length > 0);
	const selectable = [...new Map([...recent, ...withEvents].map((step) => [step.index, step])).values()].sort(
		(a, b) => a.index - b.index,
	);
	const options = selectable
		.map(
			(step) =>
				`<option value="${step.index}"${step === steps.at(-1) ? " selected" : ""}>${esc(t(lang, { key: "browser.pickLabel", params: { t: step.turn, s: step.stepInTurn } }))}${step.hasDetails ? "" : " (Σ)"}</option>`,
		)
		.join("");
	const current = steps[steps.length - 1];
	if (current === undefined) return "";
	const rows = GROUPS.map((group) => categoryRow(report, current, group)).join("");
	const panel = panelOf(report, current, true);
	const dna = dnaList(report, current);
	const missing = steps.filter((step) => !step.hasDetails).length;
	const windowNote =
		missing > 0
			? `<p class="dim" data-window-note>${t(lang, { key: "browser.windowNote", params: { count: missing } })}</p>`
			: "";

	return `<section class="card" id="browser" data-card="browser"><h2 data-i18n="browser.title">${esc(t(lang, { key: "browser.title" }))}</h2>
<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px">
<label class="dim">${t(lang, { key: "browser.step" })} <select data-browser-step>${options}</select></label>
<button type="button" data-toggle="dna" data-value="dna" aria-pressed="false">${t(lang, { key: "toggle.dna" })}</button>
<button type="button" data-toggle="mode" data-value="total" aria-pressed="true">${t(lang, { key: "toggle.total" })}</button>
<button type="button" data-toggle="mode" data-value="delta" aria-pressed="false">${t(lang, { key: "toggle.delta" })}</button>
<input type="search" data-filter-group="items" placeholder="${esc(t(lang, { key: "browser.search" }))}">
</div>
${windowNote}
<table><thead><tr><th>${t(lang, { key: "table.category" })}</th><th class="num">${t(lang, { key: "table.items" })}</th><th class="num">${t(lang, { key: "table.tokens" })}</th><th class="num">${t(lang, { key: "table.share" })}</th><th class="num">Δ</th></tr></thead><tbody>${rows}</tbody></table>
<div data-browser-panels style="margin-top:10px">${panel}</div>
<details style="margin-top:10px"><summary>${t(lang, { key: "browser.dnaTitle" })}</summary>${dna}</details>
</section>`;
}
