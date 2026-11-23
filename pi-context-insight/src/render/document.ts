import { DICT, t } from "../i18n";
import type { Msg } from "../model";
import type { InsightReport } from "../report";
import { esc } from "./escape";
import { REPORT_CSS } from "./style";

export const SECTION_IDS = [
	"overview",
	"tokens",
	"timing",
	"context",
	"timeline",
	"browser",
	"events",
	"activity",
	"family",
	"notes",
] as const;

const WARNING_VISIBLE = 8;

function anchors(lang: InsightReport["lang"]): string {
	return SECTION_IDS.map((id) => `<a href="#${id}" data-anchor="${id}" data-i18n="anchor.${id}">${esc(t(lang, { key: `anchor.${id}` }))}</a>`).join(
		"",
	);
}

function warningsPanel(report: InsightReport): string {
	if (report.warnings.length === 0) return "";
	const visible = report.warnings.slice(0, WARNING_VISIBLE);
	const rest = report.warnings.length - visible.length;
	const items = visible.map((warning) => `<li data-warning="1">${esc(t(report.lang, warning))}</li>`).join("");
	const more =
		rest > 0
			? `<p class="dim" data-warning-more>${esc(t(report.lang, { key: "warn.more", params: { count: rest } }))}</p>`
			: "";
	return `<section class="warn-panel" data-card="warnings"><ul>${items}</ul>${more}</section>`;
}

function truncationNotes(report: InsightReport): string {
	if (report.truncation.length === 0) {
		return `<li>${t(report.lang, { key: "notes.noTruncation" })}</li>`;
	}
	return report.truncation
		.map(
			(entry) =>
				`<li data-truncation="${entry.kind}">${t(report.lang, {
					key: `notes.truncation.${entry.kind}`,
					params: { limit: entry.limit, actual: entry.actual },
				})}</li>`,
		)
		.join("");
}

function dataNotes(report: InsightReport): string {
	const lang = report.lang;
	return `<section class="card" id="notes" data-card="notes"><h2>${t(lang, { key: "notes.title" })}</h2>
<ol class="notes">
<li>${t(lang, { key: "notes.estimate" })}</li>
<li>${t(lang, { key: "notes.scope" })}</li>
<li>${t(lang, { key: "notes.truncation" })}<ul>${truncationNotes(report)}</ul></li>
<li>${t(lang, { key: report.mode === "full" ? "notes.privacyFull" : "notes.privacyShort" })}</li>
</ol></section>`;
}

export function renderDocument(args: {
	report: InsightReport;
	body: string;
	payload: string;
	runtime?: string;
}): string {
	const { report, body, payload } = args;
	const lang = report.lang;
	const title = report.metadata.name ?? `Session ${report.metadata.id}`;
	const csp =
		report.mode === "full"
			? "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"
			: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
	const banner =
		report.mode === "full" ? `<div class="banner" data-banner="raw-content" data-i18n="doc.banner">${esc(t(lang, { key: "doc.banner" }))}</div>` : "";
	const runtime = args.runtime ?? "";
	const meta = [report.metadata.model ?? "—", report.metadata.thinkingLevel, report.metadata.cwd, report.generatedAt]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.map((value) => `<span class="dim">${esc(value)}</span>`)
		.join(" · ");

	return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${esc(t(lang, { key: "doc.title" }))} — ${esc(title)}</title><style>${REPORT_CSS}</style></head>
<body>
<header class="top"><h1 data-i18n="doc.title">${esc(t(lang, { key: "doc.title" }))}</h1>
<span class="badge ${report.mode}">${t(lang, { key: report.mode === "full" ? "doc.modeFull" : "doc.modeShort" })}</span>
<div class="dim">${esc(title)} · <code>${esc(report.metadata.id)}</code> · ${meta}</div>
<nav class="anchors">${anchors(lang)}<span class="actions">
<button type="button" data-lang-switch="en" aria-pressed="${lang === "en"}">EN</button>
<button type="button" data-lang-switch="zh" aria-pressed="${lang === "zh"}">中文</button></span></nav>
</header>
<main>
${banner}
${warningsPanel(report)}
${body}
${dataNotes(report)}
</main>
<footer data-i18n="doc.footer">${esc(t(lang, { key: "doc.footer" }))}</footer>
<noscript><p class="dim">${t(lang, { key: "doc.noscript" })}</p></noscript>
<script type="application/json" id="insight-payload">${payload}</script>
<script>${runtime}</script>
</body></html>`;
}

export function msgsOf(report: InsightReport, msgs: readonly Msg[]): string[] {
	return msgs.map((msg) => t(report.lang, msg));
}

export { DICT };
