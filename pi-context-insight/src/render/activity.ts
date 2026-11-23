import type { CommandStatus } from "../activity/commands";
import type { FileOpKind } from "../activity/files";
import { fmtClock, fmtCost, fmtDuration, fmtShare, fmtTokens } from "../format";
import { t } from "../i18n";
import type { InsightReport } from "../report";
import { esc } from "./escape";

const FILE_KINDS: readonly FileOpKind[] = ["read", "write", "search", "image"];
const COMMAND_FILTERS = ["all", "failed", "slow", "nested"] as const;

function toolsCard(report: InsightReport): string {
	const lang = report.lang;
	if (report.tools.length === 0) {
		return `<div data-card="tools"><h3>${t(lang, { key: "activity.tools" })}</h3><p class="dim" data-empty="tools">${t(lang, { key: "empty.tools" })}</p></div>`;
	}
	const rows = report.tools
		.map((row) => {
			const spark = row.perStep
				.map((count, index) =>
					count > 0
						? `<i style="display:inline-block;width:3px;height:${Math.min(12, 3 + count * 2)}px;background:var(--accent)" title="${esc(`${index + 1}: ${count}`)}"></i>`
						: "",
				)
				.join("");
			return `<tr class="row" data-tool-row="${esc(row.name)}"><td>${esc(row.name)} <span class="tag" data-tool-source="${row.source}">${esc(row.sourceLabel || row.source)}</span></td><td class="num">${row.calls}</td><td class="num">${row.ok}</td><td class="num">${row.errors}</td><td class="num">${row.missing}</td><td class="num">${row.durationMs === 0 && row.durationEstimated ? "—" : `${row.durationEstimated ? "≈" : ""}${fmtDuration(row.durationMs)}`}</td><td class="num">≈${fmtTokens(row.tokens)}</td><td>${spark}</td></tr>`;
		})
		.join("");
	return `<div data-card="tools"><h3>${t(lang, { key: "activity.tools" })}</h3><table><thead><tr><th>${t(lang, { key: "table.tool" })}</th><th class="num">${t(lang, { key: "table.calls" })}</th><th class="num">ok</th><th class="num">err</th><th class="num">?</th><th class="num">${t(lang, { key: "table.duration" })}</th><th class="num">≈tokens</th><th>${t(lang, { key: "table.byStep" })}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function filesCard(report: InsightReport): string {
	const lang = report.lang;
	const chips = FILE_KINDS.map(
		(kind) =>
			`<button type="button" data-file-filter="${kind}" aria-pressed="false">${esc(t(lang, { key: `files.kind.${kind}` }))} ${report.files.reduce((sum, row) => sum + row.counts[kind], 0)}</button>`,
	).join("");
	const body =
		report.files.length === 0
			? `<p class="dim" data-empty="files">${t(lang, { key: "empty.files" })}</p>`
			: report.files
					.map((row) => {
						const badges = FILE_KINDS.filter((kind) => row.counts[kind] > 0)
							.map((kind) => `<span class="tag">${esc(t(lang, { key: `files.kind.${kind}` }))} ${row.counts[kind]}</span>`)
							.join("");
						const ops = row.ops
							.map(
								(op) =>
									`<div class="row" data-file-op="${esc(op.id)}" data-locate-tool="${esc(op.toolCallId ?? "")}"><span class="tag">${esc(op.tool)}</span>${op.hits === undefined ? "" : `<span class="dim">${t(lang, { key: "files.hits", params: { count: op.hits } })}</span>`}${op.readRange === undefined ? "" : `<span class="dim">${op.readRange.estimated ? "≈" : ""}${op.readRange.start}–${op.readRange.start + op.readRange.count - 1}</span>`}${op.added + op.removed === 0 ? "" : ` <span class="dim">+${op.added} −${op.removed}</span>`}${op.isError ? ' <span class="flag">✕</span>' : ""}<span class="dim"> · ${esc(fmtClock(op.timestamp))}</span></div>`,
							)
							.join("");
						return `<details class="row" data-path="${esc(row.path)}"><summary><code>${esc(row.path)}</code> ${badges} <span class="dim">+${row.added} −${row.removed} · ${esc(fmtClock(row.lastTimestamp))}</span></summary>${ops}</details>`;
					})
					.join("");
	return `<div data-card="files"><h3>${t(lang, { key: "activity.files" })}</h3>
<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">${chips}</div>
<input type="search" data-filter-group="files" placeholder="${esc(t(lang, { key: "files.search" }))}">
${body}
<p class="dim">${t(lang, { key: "files.note" })}</p></div>`;
}

function commandsCard(report: InsightReport): string {
	const lang = report.lang;
	const commands = report.commands;
	const filters = COMMAND_FILTERS.map(
		(filter) =>
			`<button type="button" data-command-filter="${filter}" aria-pressed="${filter === "all"}">${esc(t(lang, { key: `cmds.filter.${filter}` }))} ${filter === "all" ? commands.runs : filter === "failed" ? commands.failed : filter === "nested" ? commands.nested : commands.records.filter((record) => (record.durationMs ?? 0) >= 10_000).length}</button>`,
	).join("");
	const rail = `<div><div class="kpi-label">${t(lang, { key: "cmds.summary" })}</div>
<div>${t(lang, { key: "cmds.runs", params: { count: commands.runs } })} · ${t(lang, { key: "cmds.total", params: { dur: fmtDuration(commands.totalMs) } })} · ${t(lang, { key: "cmds.failed", params: { count: commands.failed, share: fmtShare(commands.failed, commands.runs) } })}</div>
<div class="kpi-label" style="margin-top:8px">${t(lang, { key: "cmds.notable" })}</div>
<ul>${commands.notable.slowest === undefined ? "" : `<li>${t(lang, { key: "cmds.slowest", params: { command: commands.notable.slowest.program, dur: fmtDuration(commands.notable.slowest.durationMs ?? 0) } })}</li>`}${commands.notable.mostFailing === undefined ? "" : `<li>${t(lang, { key: "cmds.mostFailing", params: { program: commands.notable.mostFailing.name, count: commands.notable.mostFailing.count } })}</li>`}${commands.notable.mostRepeated === undefined ? "" : `<li>${t(lang, { key: "cmds.mostRepeated", params: { count: commands.notable.mostRepeated.count } })}</li>`}</ul>
<div class="kpi-label" style="margin-top:8px">${t(lang, { key: "cmds.programs", params: { count: commands.programs.length } })}</div>
${commands.programs
	.slice(0, 8)
	.map(
		(program) =>
			`<div class="row" data-command-program="${esc(program.name)}">${esc(program.name)} <span class="dim">×${program.runs} · ${program.records}</span></div>`,
	)
	.join("")}</div>`;

	const rows =
		commands.records.length === 0
			? `<p class="dim" data-empty="commands">${t(lang, { key: "empty.commands" })}</p>`
			: commands.records
					.slice()
					.reverse()
					.map((record) => {
						const status: CommandStatus = record.status;
						const glyph = status === "ok" ? "✓" : status === "error" ? "✕" : status === "cancelled" ? "⏹" : "⏳";
						const detail =
							report.mode === "short"
								? `<p class="dim" data-empty="browser-body">${t(lang, { key: "empty.shortNoBody" })}</p>`
								: `<pre class="body">${esc(record.command)}</pre>`;
						return `<details class="row" data-program="${esc(record.program)}" data-status="${status}" data-command="${esc(record.id)}"><summary>${glyph} <span class="tag">${esc(record.tool)}</span><code>${esc(record.command.split(/\r?\n/)[0]?.slice(0, 80) ?? "")}</code> <span class="dim">${record.durationMs === undefined ? "" : `${record.durationEstimated ? "≈" : ""}${fmtDuration(record.durationMs)}`} · ${esc(fmtClock(record.timestamp))}</span></summary>${detail}
<p class="dim">${record.exitCode === undefined ? "" : `${t(lang, { key: "cmds.exit", params: { code: record.exitCode } })}${record.exitInferred ? " ≈" : ""} · `}${record.outputChars} chars${record.stderr ? " · stderr" : ""}${record.timedOut ? ` · ${t(lang, { key: "cmds.timedOut" })}` : ""}${record.denied ? ` · ${t(lang, { key: "cmds.denied" })}` : ""}</p></details>`;
					})
					.join("");

	return `<div data-card="commands"><h3>${t(lang, { key: "activity.commands" })}</h3>
<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">${filters}</div>
<div class="grid2"><div>${rail}</div><div><input type="search" data-filter-group="commands" placeholder="${esc(t(lang, { key: "cmds.search" }))}">${rows}</div></div></div>`;
}

export function renderActivity(report: InsightReport): string {
	const lang = report.lang;
	return `<section class="card" id="activity" data-card="activity"><h2>${t(lang, { key: "activity.title" })}</h2>
${toolsCard(report)}<hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
<div class="grid2">${filesCard(report)}${commandsCard(report)}</div></section>`;
}

export { fmtCost };
