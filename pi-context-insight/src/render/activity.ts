import type { CommandStatus } from "../activity/commands";
import type { FileOpKind } from "../activity/files";
import { fmtClock, fmtDuration, fmtShare, fmtTokens } from "../format";
import { t } from "../i18n";
import type { InsightReport } from "../report";
import { esc } from "./escape";
import { i18nAttrs, microbar, section } from "./layout";

const FILE_KINDS: readonly FileOpKind[] = ["read", "write", "search", "image"];
const FILE_FILTERS = ["all", ...FILE_KINDS] as const;
const COMMAND_FILTERS = ["all", "failed", "slow", "nested"] as const;
/** The per-step spark is capped so a long session cannot stretch the row. */
const SPARK_BUCKETS = 40;

interface SparkBucket {
	from: number;
	to: number;
	count: number;
}

/** Sums a per-step distribution into at most `max` buckets, keeping its shape. */
export function sparkSeries(perStep: readonly number[], max = SPARK_BUCKETS): SparkBucket[] {
	if (perStep.length <= max) return perStep.map((count, index) => ({ from: index, to: index, count }));
	const size = Math.ceil(perStep.length / max);
	const buckets: SparkBucket[] = [];
	for (let start = 0; start < perStep.length; start += size) {
		const slice = perStep.slice(start, start + size);
		buckets.push({ from: start, to: start + slice.length - 1, count: slice.reduce((sum, value) => sum + value, 0) });
	}
	return buckets;
}

function sparkBar(bucket: SparkBucket): string {
	if (bucket.count === 0) return `<i style="height:1px;background:transparent"></i>`;
	const label =
		bucket.from === bucket.to
			? `${bucket.from + 1}: ${bucket.count}`
			: `${bucket.from + 1}-${bucket.to + 1}: ${bucket.count}`;
	return `<i style="height:${Math.min(12, 3 + bucket.count * 2)}px" title="${esc(label)}"></i>`;
}

function toolsCard(report: InsightReport): string {
	const lang = report.lang;
	const titleKey = "activity.tools";
	if (report.tools.length === 0) {
		return section({
			id: "activity",
			cardId: "tools",
			titleKey,
			lang,
			body: `<p class="dim" data-empty="tools">${t(lang, { key: "empty.tools" })}</p>`,
		});
	}
	const max = Math.max(1, ...report.tools.map((row) => row.calls));
	const rows = report.tools
		.map((row) => {
			const spark = sparkSeries(row.perStep).map(sparkBar).join("");
			const duration =
				row.durationMs === 0 && row.durationEstimated
					? "—"
					: `${row.durationEstimated ? "≈" : ""}${fmtDuration(row.durationMs)}`;
			return `<div class="tool-row" data-tool-row="${esc(row.name)}"><span class="tool-name">${esc(row.name)}</span><span class="tag" data-tool-source="${row.source}">${esc(row.sourceLabel || row.source)}</span><span class="tool-bar" data-bar="${esc(row.name)}">${microbar({ value: row.calls, max, tone: "accent" })}</span><span class="dim">${row.calls} ${t(lang, { key: "table.calls" })}</span><span class="dim">ok ${row.ok} · err ${row.errors}${row.missing === 0 ? "" : ` · ? ${row.missing}`}</span><span class="dim">${esc(duration)}</span><span class="dim">≈${fmtTokens(row.tokens)}</span><span class="tool-spark">${spark}</span></div>`;
		})
		.join("");
	const body = `<div class="tool-list"><div class="kpi-label">${t(lang, { key: "table.tool" })}</div>${rows}</div>`;
	return section({ id: "activity", cardId: "tools", titleKey, lang, body });
}

function filesCard(report: InsightReport): string {
	const lang = report.lang;
	const chips = FILE_FILTERS.map((filter) => {
		const key = filter === "all" ? "files.filter.all" : `files.kind.${filter}`;
		const count = filter === "all" ? report.files.length : report.files.filter((row) => row.counts[filter] > 0).length;
		return `<button type="button" data-file-filter="${filter}" aria-pressed="${filter === "all"}"><span ${i18nAttrs(key)}>${esc(t(lang, { key }))}</span> <span class="dim">${count}</span></button>`;
	}).join("");
	const rows =
		report.files.length === 0
			? `<p class="dim" data-empty="files">${t(lang, { key: "empty.files" })}</p>`
			: report.files
					.map((row) => {
						const badges = FILE_KINDS.filter((kind) => row.counts[kind] > 0)
							.map(
								(kind) =>
									`<span class="tag" data-kind="${kind}">${esc(t(lang, { key: `files.kind.${kind}` }))} ${row.counts[kind]}</span>`,
							)
							.join("");
						const ops = row.ops
							.map(
								(op) =>
									`<div class="file-op" data-file-op="${esc(op.id)}" data-locate-tool="${esc(op.toolCallId ?? "")}"><span class="tag">${esc(op.tool)}</span>${op.hits === undefined ? "" : `<span class="dim">${t(lang, { key: "files.hits", params: { count: op.hits } })}</span>`}${op.readRange === undefined ? "" : `<span class="dim">${op.readRange.estimated ? "≈" : ""}${op.readRange.start}–${op.readRange.start + op.readRange.count - 1}</span>`}${op.added + op.removed === 0 ? "" : ` <span class="dim">+${op.added} −${op.removed}</span>`}${op.isError ? ' <span class="flag">✕</span>' : ""}<span class="dim"> · ${esc(fmtClock(op.timestamp))}</span></div>`,
							)
							.join("");
						return `<details class="file-row" data-path="${esc(row.path)}" data-search="${esc(row.path.toLowerCase())}"><summary><code>${esc(row.path)}</code> ${badges} <span class="dim">+${row.added} −${row.removed} · ${esc(fmtClock(row.lastTimestamp))}</span></summary>${ops}</details>`;
					})
					.join("");
	const content = `<div class="toolbar">${chips}</div>
<input type="search" data-filter-group="files" placeholder="${esc(t(lang, { key: "files.search" }))}">
<div class="scroll-list" data-scroll-list="files">${rows}</div>
<p class="dim" style="margin:8px 0 0">${t(lang, { key: "files.note" })}</p>`;
	return section({ id: "files", titleKey: "activity.files", lang, span: 6, body: content });
}

function commandsCard(report: InsightReport): string {
	const lang = report.lang;
	const commands = report.commands;
	const filters = COMMAND_FILTERS.map(
		(filter) =>
			`<button type="button" data-command-filter="${filter}" aria-pressed="${filter === "all"}"><span ${i18nAttrs(`cmds.filter.${filter}`)}>${esc(t(lang, { key: `cmds.filter.${filter}` }))}</span> <span class="dim">${filter === "all" ? commands.runs : filter === "failed" ? commands.failed : filter === "nested" ? commands.nested : commands.records.filter((record) => (record.durationMs ?? 0) >= 10_000).length}</span></button>`,
	).join("");
	const rail = `<div class="rail-stats">
<div class="kpi-label">${t(lang, { key: "cmds.summary" })}</div>
<div>${t(lang, { key: "cmds.runs", params: { count: commands.runs } })} · ${t(lang, { key: "cmds.total", params: { dur: fmtDuration(commands.totalMs) } })} · ${t(lang, { key: "cmds.failed", params: { count: commands.failed, share: fmtShare(commands.failed, commands.runs) } })}</div>
<div class="kpi-label" style="margin-top:8px">${t(lang, { key: "cmds.notable" })}</div>
<ul class="dim">${commands.notable.slowest === undefined ? "" : `<li>${t(lang, { key: "cmds.slowest", params: { command: commands.notable.slowest.program, dur: fmtDuration(commands.notable.slowest.durationMs ?? 0) } })}</li>`}${commands.notable.mostFailing === undefined ? "" : `<li>${t(lang, { key: "cmds.mostFailing", params: { program: commands.notable.mostFailing.name, count: commands.notable.mostFailing.count } })}</li>`}${commands.notable.mostRepeated === undefined ? "" : `<li>${t(lang, { key: "cmds.mostRepeated", params: { count: commands.notable.mostRepeated.count } })}</li>`}</ul>
<div class="kpi-label" style="margin-top:8px">${t(lang, { key: "cmds.programs", params: { count: commands.programs.length } })}</div>
${commands.programs
	.slice(0, 8)
	.map(
		(program) =>
			`<div class="row" data-command-program="${esc(program.name)}">${esc(program.name)} <span class="dim">×${program.runs} · ${program.records}</span></div>`,
	)
	.join("")}</div>`;

	const commandRows =
		commands.records.length === 0
			? `<p class="dim" data-empty="commands">${t(lang, { key: "empty.commands" })}</p>`
			: commands.records
					.slice()
					.reverse()
					.map((record) => {
						const status: CommandStatus = record.status;
						const glyph = status === "ok" ? "✓" : status === "error" ? "✕" : status === "cancelled" ? "⏹" : "⏳";
						const summaryText =
							report.mode === "short"
								? `${record.program} · ${t(lang, { key: "cmds.lines", params: { count: record.lineCount } })}`
								: (record.command.split(/\r?\n/)[0]?.slice(0, 80) ?? "");
						const detail =
							report.mode === "short"
								? `<p class="dim" data-empty="browser-body">${t(lang, { key: "empty.shortNoBody" })}</p>`
								: `<pre class="body">${esc(record.command)}</pre>`;
						const slow = (record.durationMs ?? 0) >= 10_000 ? "1" : "0";
						const errorClass = status === "error" ? " is-error" : "";
						return `<details class="cmd-row${errorClass}" data-program="${esc(record.program)}" data-status="${status}" data-command="${esc(record.id)}" data-nested="${record.nested ? 1 : 0}" data-slow="${slow}" data-search="${esc(`${record.program} ${record.command}`.toLowerCase())}"><summary><span class="cmd-glyph" data-status="${status}">${glyph}</span><span class="tag">${esc(record.tool)}</span><code>${esc(summaryText)}</code> <span class="dim">${record.durationMs === undefined ? "" : `${record.durationEstimated ? "≈" : ""}${fmtDuration(record.durationMs)}`} · ${esc(fmtClock(record.timestamp))}</span></summary>${detail}
<p class="dim">${record.exitCode === undefined ? "" : `${t(lang, { key: "cmds.exit", params: { code: record.exitCode } })}${record.exitInferred ? " ≈" : ""} · `}${record.outputChars} chars${record.stderr ? " · stderr" : ""}${record.timedOut ? ` · ${t(lang, { key: "cmds.timedOut" })}` : ""}${record.denied ? ` · ${t(lang, { key: "cmds.denied" })}` : ""}</p></details>`;
					})
					.join("");

	const content = `<div class="split split-commands"><div>${rail}</div><div><div class="toolbar">${filters}</div><input type="search" data-filter-group="commands" placeholder="${esc(t(lang, { key: "cmds.search" }))}"><div class="scroll-list" data-scroll-list="commands">${commandRows}</div></div></div>`;
	return section({ id: "commands", titleKey: "activity.commands", lang, span: 6, body: content });
}

export function renderActivity(report: InsightReport): string {
	return [toolsCard(report), filesCard(report), commandsCard(report)].join("\n");
}
