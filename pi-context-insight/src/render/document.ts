import { t } from "../i18n";
import type { InsightReport } from "../report";
import { esc } from "./escape";
import { chip, i18nAttrs } from "./layout";
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

function railNav(lang: InsightReport["lang"]): string {
	return SECTION_IDS.map(
		(id) =>
			`<a href="#${id}" data-rail-item="${id}" ${i18nAttrs(`anchor.${id}`)}>${esc(t(lang, { key: `anchor.${id}` }))}</a>`,
	).join("");
}

function rail(report: InsightReport, title: string): string {
	const lang = report.lang;
	const meta = [report.metadata.model ?? "—", report.metadata.thinkingLevel, report.metadata.cwd]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.map((value) => `<span>${esc(value)}</span>`)
		.join("");
	const mode = chip({
		text: t(lang, { key: report.mode === "full" ? "doc.modeFull" : "doc.modeShort" }),
		tone: report.mode === "full" ? "warn" : "dim",
		i18n: report.mode === "full" ? "doc.modeFull" : "doc.modeShort",
	});
	return `<aside class="rail">
<div class="rail-title" data-session-title>${esc(title)}</div>
<div class="rail-meta">${mode}<span>${esc(report.generatedAt)}</span></div>
<div class="rail-meta">${meta}</div>
<div class="rail-label" ${i18nAttrs("rail.title")}>${esc(t(lang, { key: "rail.title" }))}</div>
<nav class="rail-nav">${railNav(lang)}</nav>
<div class="rail-actions">
<button type="button" data-lang-switch="en" aria-pressed="${lang === "en"}">EN</button>
<button type="button" data-lang-switch="zh" aria-pressed="${lang === "zh"}">中文</button>
</div>
</aside>`;
}

function warningsPanel(report: InsightReport): string {
	if (report.warnings.length === 0) return "";
	const lang = report.lang;
	const visible = report.warnings.slice(0, WARNING_VISIBLE);
	const rest = report.warnings.length - visible.length;
	const items = visible
		.map((warning) => {
			const text = t(lang, warning);
			return `<li data-warning="1"${warning.params === undefined ? i18nAttrs(warning.key) : ""}>${esc(text)}</li>`;
		})
		.join("");
	const more =
		rest > 0
			? `<p class="dim" data-warning-more>${esc(t(lang, { key: "warn.more", params: { count: rest } }))}</p>`
			: "";
	return `<section class="card span-12 warn-panel" data-card="warnings"><h2><span ${i18nAttrs("warn.title")}>${esc(t(lang, { key: "warn.title" }))}</span></h2><ul>${items}</ul>${more}</section>`;
}

function truncationNotes(report: InsightReport): string {
	if (report.truncation.length === 0) {
		return `<li ${i18nAttrs("notes.noTruncation")}>${t(report.lang, { key: "notes.noTruncation" })}</li>`;
	}
	return report.truncation
		.map((entry) => {
			const params = { limit: entry.limit, actual: entry.actual };
			return `<li data-truncation="${entry.kind}">${t(report.lang, { key: `notes.truncation.${entry.kind}`, params })}</li>`;
		})
		.join("");
}

function dataNotes(report: InsightReport): string {
	const lang = report.lang;
	return `<section class="card span-12" id="notes" data-card="notes"><h2><span ${i18nAttrs("notes.title")}>${esc(t(lang, { key: "notes.title" }))}</span></h2>
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
		report.mode === "full"
			? `<div class="card span-12 banner" data-banner="raw-content" ${i18nAttrs("doc.banner")}>${esc(t(lang, { key: "doc.banner" }))}</div>`
			: "";
	const runtime = args.runtime ?? "";

	return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${esc(t(lang, { key: "doc.title" }))} — ${esc(title)}</title><style>${REPORT_CSS}</style></head>
<body>
<div class="shell">
${rail(report, title)}
<main class="main">
${banner}
${warningsPanel(report)}
${body}
${dataNotes(report)}
<footer ${i18nAttrs("doc.footer")}>${esc(t(lang, { key: "doc.footer" }))}</footer>
</main>
</div>
<noscript><p class="dim" ${i18nAttrs("doc.noscript")}>${t(lang, { key: "doc.noscript" })}</p></noscript>
<script type="application/json" id="insight-payload">${payload}</script>
<script>${runtime}</script>
</body></html>`;
}
