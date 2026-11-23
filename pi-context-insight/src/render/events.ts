import { fmtClock, fmtTokens } from "../format";
import { t } from "../i18n";
import type { InsightReport } from "../report";
import { eventKinds } from "../session/events";
import { esc } from "./escape";
import { section } from "./layout";

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
		return section({
			id: "events",
			titleKey: "events.title",
			lang,
			body: `<p class="dim" data-empty="events">${t(lang, { key: "empty.events" })}</p>`,
		});
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
			const deltaTone = delta === 0 ? "zero" : delta > 0 ? "up" : "down";
			const step = report.steps[event.stepIndex];
			const position = step === undefined ? `#${event.stepIndex + 1}` : `T${step.turn} S${step.stepInTurn}`;
			return `<div class="event-row" data-event="${event.id}" data-kind="${event.kind}" data-status="${event.kind}" data-search="${esc(t(lang, event.text).toLowerCase())}"><span class="dim event-clock">${esc(fmtClock(event.timestamp))}</span><span class="dot" style="background:var(--${event.kind === "compaction" ? "compaction" : "systemSkills"})"></span><span class="event-text">${esc(t(lang, event.text))}</span><button type="button" class="chip" data-locate-step="${event.stepIndex}">${esc(position)}</button><span class="delta delta-${deltaTone}">${esc(deltaText)}</span></div>`;
		})
		.join("");

	const body = `<div class="toolbar" data-filter-group="events">${tabs}</div>
<div class="event-list">${rows}</div>`;

	return section({ id: "events", titleKey: "events.title", lang, body });
}
