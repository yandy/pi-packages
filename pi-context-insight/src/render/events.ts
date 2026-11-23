import { fmtClock, fmtTokens } from "../format";
import { t } from "../i18n";
import type { InsightReport } from "../report";
import { eventKinds } from "../session/events";
import { esc } from "./escape";

const KIND_TAB_KEY: Record<string, string> = {
	all: "events.all",
	compaction: "flag.compaction",
	contextEdit: "flag.contextEdit",
	branchSummary: "flag.branchSummary",
	model: "flag.model",
	thinking: "flag.thinking",
	skill: "flag.skill",
	inject: "flag.inject",
	delegate: "flag.delegate",
	childDone: "flag.childDone",
	ask: "flag.ask",
	todo: "flag.todo",
};

export function renderEvents(report: InsightReport): string {
	const lang = report.lang;
	if (report.events.length === 0) {
		return `<section class="card" id="events" data-card="events"><h2>${t(lang, { key: "events.title" })}</h2><p class="dim" data-empty="events">${t(lang, { key: "empty.events" })}</p></section>`;
	}
	const counts = new Map<string, number>();
	for (const event of report.events) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);

	const tabs = ["all", ...eventKinds()]
		.map(
			(kind) =>
				`<button type="button" data-event-filter="${kind}" aria-pressed="${kind === "all"}">${esc(t(lang, { key: KIND_TAB_KEY[kind] ?? kind }))} ${kind === "all" ? report.events.length : (counts.get(kind) ?? 0)}</button>`,
		)
		.join("");

	const rows = report.events
		.slice()
		.reverse()
		.map((event) => {
			const delta = event.tokens ?? 0;
			const deltaText = delta === 0 ? "—" : `${delta > 0 ? "+" : ""}${fmtTokens(delta)}`;
			const step = report.steps[event.stepIndex];
			const position = step === undefined ? `#${event.stepIndex + 1}` : `T${step.turn} S${step.stepInTurn}`;
			return `<tr class="row" data-event="${event.id}" data-kind="${event.kind}" data-status="${event.kind}"><td>${esc(t(lang, { key: KIND_TAB_KEY[event.kind] ?? event.kind }))}</td><td>${esc(t(lang, event.text))}</td><td class="dim">${esc(position)}</td><td class="num">${esc(deltaText)}</td><td class="dim">${esc(fmtClock(event.timestamp))}</td></tr>`;
		})
		.join("");

	return `<section class="card" id="events" data-card="events"><h2>${t(lang, { key: "events.title" })}</h2>
<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px" data-filter-group="events">${tabs}</div>
<table><thead><tr><th>${t(lang, { key: "table.kind" })}</th><th>${t(lang, { key: "table.detail" })}</th><th>${t(lang, { key: "table.at" })}</th><th class="num">Δ</th><th>${t(lang, { key: "table.time" })}</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}
