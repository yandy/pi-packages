import { fmtClock, fmtTokens } from "../format";
import { t } from "../i18n";
import type { CategoryId, Lang } from "../model";
import type { InsightReport } from "../report";
import type { Item } from "../session/categorize";
import type { Step } from "../session/steps";
import { CATEGORY_LABEL_KEY, categoryLabel } from "./categories";
import { esc } from "./escape";
import { section } from "./layout";

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

function groupLabel(lang: Lang, group: CategoryId): string {
	return t(lang, { key: GROUP_LABEL_KEY[group] ?? CATEGORY_LABEL_KEY[group] ?? "empty.none" });
}

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
	const errorClass = item.isError === true ? " is-error" : "";
	return `<details class="item-row${errorClass}" data-item="${item.id}" data-cat="${item.category}"${kindAttr} data-search="${esc(search)}"><summary><span class="tag">${esc(categoryLabel(lang, item.category))}</span>${chips}<span class="item-preview dim">${esc(preview(report, item))}</span><span class="item-meta dim">≈${fmtTokens(item.tokens)} · ${esc(clock)}</span>${item.truncated === true ? ` <span class="flag">${esc(t(lang, { key: "browser.truncated", params: { chars: item.originalLength ?? 0 } }))}</span>` : ""}</summary>${body}</details>`;
}

function indexRow(report: InsightReport, step: Step, group: CategoryId): string {
	const list = itemsOfStep(report, step).filter((item) => GROUP_OF[item.category] === group);
	const tokens = list.reduce((sum, item) => sum + item.tokens, 0);
	const share = step.estimatedTotal > 0 ? (tokens / step.estimatedTotal) * 100 : 0;
	const delta = step.delta[group] ?? 0;
	const badge =
		delta === 0 ? "" : `<span class="tag" data-delta="${group}">${delta > 0 ? "+" : ""}${fmtTokens(delta)}</span>`;
	return `<button type="button" class="idx-row" data-cat-index="${group}" data-cat-row="${group}" data-count="${list.length}" data-tokens="${tokens}" data-share="${share.toFixed(1)}"><span class="dot" style="background:var(--${group})"></span><span class="idx-label">${esc(groupLabel(report.lang, group))}</span><span class="idx-count dim">${list.length}</span><span class="idx-value">≈${fmtTokens(tokens)}</span><span class="idx-share dim">${share === 0 ? "—" : `${share.toFixed(1)}%`}</span>${badge}</button>`;
}

function panelOf(report: InsightReport, step: Step, selected: boolean): string {
	const lang = report.lang;
	const items = itemsOfStep(report, step);
	const groups = GROUPS.map((group) => {
		const all = items.filter((item) => GROUP_OF[item.category] === group);
		if (all.length === 0) return "";
		const list = all.slice(0, ROW_LIMIT);
		const rest = all.slice(ROW_LIMIT, ROW_LIMIT * 10);
		const tokens = all.reduce((sum, item) => sum + item.tokens, 0);
		const rows = list.map((item) => rowHtml(report, item)).join("");
		const more =
			rest.length > 0
				? `<details data-more="${group}"><summary>${t(lang, { key: "common.omitted", params: { count: rest.length } })}</summary>${rest.map((item) => rowHtml(report, item)).join("")}</details>`
				: "";
		return `<h4 data-cat-section="${group}">${esc(groupLabel(lang, group))} <span class="dim">${t(lang, { key: "browser.items", params: { count: all.length } })} · ≈${fmtTokens(tokens)}</span></h4>${rows}${more}`;
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
				`<div class="item-row" data-dna-item="${item.id}"><span class="tag" style="border-color:var(--${item.category})">${esc(categoryLabel(lang, item.category))}</span><span class="dim" data-dna-index="${items.length - index}">#${items.length - index}</span> ${esc(item.tag)} <span class="dim">≈${fmtTokens(item.tokens)}</span></div>`,
		)
		.join("");
	return `<div data-dna-list hidden>${rows || `<p class="dim">${t(lang, { key: "empty.none" })}</p>`}</div>`;
}

export function renderBrowser(report: InsightReport): string {
	const lang = report.lang;
	const steps = report.steps;
	if (steps.length === 0) {
		return section({
			id: "browser",
			titleKey: "browser.title",
			lang,
			body: `<p class="dim" data-empty="browser">${t(lang, { key: "empty.browserStep" })}</p>`,
		});
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
	const index = GROUPS.map((group) => indexRow(report, current, group)).join("");
	const panel = panelOf(report, current, true);
	const dna = dnaList(report, current);
	const missing = steps.filter((step) => !step.hasDetails).length;
	const windowNote =
		missing > 0
			? `<p class="dim" data-window-note>${t(lang, { key: "browser.windowNote", params: { count: missing } })}</p>`
			: "";

	const body = `<div class="toolbar">
<label class="dim">${t(lang, { key: "browser.step" })} <select data-browser-step>${options}</select></label>
<button type="button" data-toggle="dna" data-value="dna" aria-pressed="false">${t(lang, { key: "toggle.dna" })}</button>
<button type="button" data-toggle="mode" data-value="total" aria-pressed="true">${t(lang, { key: "toggle.total" })}</button>
<button type="button" data-toggle="mode" data-value="delta" aria-pressed="false">${t(lang, { key: "toggle.delta" })}</button>
<input type="search" data-filter-group="items" placeholder="${esc(t(lang, { key: "browser.search" }))}">
</div>
${windowNote}
<div class="browser">
<aside class="browser-index" data-browser-index><div class="kpi-label">${t(lang, { key: "browser.index" })}</div>${index}</aside>
<div class="browser-main">
<div class="browser-scroll" data-browser-panels>${panel}</div>
${dna}
</div>
</div>`;

	return section({ id: "browser", titleKey: "browser.title", lang, body });
}
