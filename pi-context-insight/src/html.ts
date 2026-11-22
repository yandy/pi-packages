import {
	clipText,
	escapeHtml,
	formatCost,
	formatDuration,
	formatPercent,
	formatRatio,
	formatTimestamp,
	formatTokens,
} from "./format";
import type {
	ContextCategoryId,
	CostBasis,
	InsightReport,
	SessionReport,
	UsageAggregate,
	UsageLedgerItem,
} from "./model";
import { REPORT_CSS } from "./style";

const DETAIL_LIMIT = 200;
const COMMAND_LIMIT = 1000;
const CATEGORY_LABELS: Record<ContextCategoryId, string> = {
	system: "System prompt",
	toolDefinitions: "Tool definitions",
	user: "User messages",
	injected: "Injected context",
	compaction: "Compaction summaries",
	reasoning: "Assistant reasoning",
	answers: "Assistant answers",
	toolCalls: "Tool calls",
	toolResults: "Tool results",
};
const SERIES = [
	{
		key: "input",
		label: "Uncached input",
		className: "series-input",
		value: (item: UsageLedgerItem) => item.usage.input,
	},
	{
		key: "cacheWrite",
		label: "Cache write",
		className: "series-cacheWrite",
		value: (item: UsageLedgerItem) => item.usage.cacheWrite,
	},
	{
		key: "cacheRead",
		label: "Cache read",
		className: "series-cacheRead",
		value: (item: UsageLedgerItem) => item.usage.cacheRead,
	},
	{ key: "output", label: "Output", className: "series-output", value: (item: UsageLedgerItem) => item.usage.output },
] as const;

function valueOrDash(value: unknown): string {
	return value === undefined || value === null || value === "" ? "—" : escapeHtml(value);
}

function omissionText(omitted: number): string {
	if (omitted === 0) return "";
	return `<p class="note">${omitted} more record${omitted === 1 ? "" : "s"} not shown.</p>`;
}

function costBasisLabel(basis: CostBasis): string {
	if (basis === "provider") return "Provider reported";
	if (basis === "mixed") return "Mixed";
	return "Catalog estimate";
}

function aggregateCard(title: string, aggregate: UsageAggregate): string {
	return `<div class="mini-card"><h3>${escapeHtml(title)}</h3><div class="table-wrap"><table><tbody>
<tr><th>Uncached input</th><td class="num">${formatTokens(aggregate.input)}</td></tr>
<tr><th>Cache write</th><td class="num">${formatTokens(aggregate.cacheWrite)}</td></tr>
<tr><th>Cache read</th><td class="num">${formatTokens(aggregate.cacheRead)} (${formatRatio(aggregate.cacheHitRate)})</td></tr>
<tr><th>Output</th><td class="num">${formatTokens(aggregate.output)}</td></tr>
<tr><th>Total</th><td class="num">${formatTokens(aggregate.total)}</td></tr>
<tr><th>Cost</th><td class="num">${formatCost(aggregate.cost)}</td></tr>
<tr><th>Cost basis</th><td class="num">${costBasisLabel(aggregate.costBasis)}</td></tr>
</tbody></table></div></div>`;
}

function renderKpis(report: InsightReport): string {
	const total = report.usage.total;
	const topLevelCalls = report.activity.executions.filter((execution) => !execution.nested).length;
	const cards = [
		["Total tokens", formatTokens(total.total)],
		["Cost", formatCost(total.cost)],
		["Cache hit", formatRatio(total.cacheHitRate)],
		["Tool calls", formatTokens(topLevelCalls)],
		["Subagents", formatTokens(report.subagents.length)],
		["Cost basis", costBasisLabel(total.costBasis)],
	];
	return `<section class="kpis" aria-label="Session highlights">${cards
		.map(
			([label, value]) =>
				`<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div></div>`,
		)
		.join("")}</section>`;
}

function renderUsageRecords(items: readonly UsageLedgerItem[]): string {
	if (items.length === 0) return "";
	const rows = items
		.slice(0, DETAIL_LIMIT)
		.map(
			(item) =>
				`<tr><td>${escapeHtml(formatTimestamp(item.timestamp))}</td><td>${escapeHtml(item.source)}</td><td>${valueOrDash(item.provider && item.model ? `${item.provider}/${item.model}` : undefined)}</td><td class="num">${formatTokens(item.usage.input + item.usage.cacheRead + item.usage.cacheWrite)}</td><td class="num">${formatTokens(item.usage.output)}</td><td class="num">${formatCost(item.usage.cost.total)}</td></tr>`,
		);
	return `<details class="activity-details"><summary>Usage records (${items.length})</summary><div class="table-wrap"><table><thead><tr><th>Time</th><th>Source</th><th>Model</th><th class="num">Prompt</th><th class="num">Output</th><th class="num">Cost</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>${omissionText(Math.max(0, items.length - DETAIL_LIMIT))}</details>`;
}

function renderUsageSection(report: SessionReport, includeSplit: boolean): string {
	const usage = report.usage;
	const split = includeSplit
		? `<div class="grid-2">${aggregateCard("Parent direct", usage.direct)}${aggregateCard("Subagents forwarded", usage.forwardedSubagents)}</div>`
		: "";
	const models = usage.byModel.length
		? `<h3>By model</h3><div class="table-wrap"><table><thead><tr><th>Model / bucket</th><th class="num">Prompt</th><th class="num">Output</th><th class="num">Total</th><th class="num">Cache hit</th><th class="num">Cost</th></tr></thead><tbody>${usage.byModel
				.map(
					(entry) =>
						`<tr><td>${escapeHtml(entry.key)}</td><td class="num">${formatTokens(entry.totals.prompt)}</td><td class="num">${formatTokens(entry.totals.output)}</td><td class="num">${formatTokens(entry.totals.total)}</td><td class="num">${formatRatio(entry.totals.cacheHitRate)}</td><td class="num">${formatCost(entry.totals.cost)}</td></tr>`,
				)
				.join("")}</tbody></table></div>`
		: "";
	return `<section><h2>Usage ledger</h2><h3>Session total</h3><div class="grid-2">${aggregateCard("Session total", usage.total)}<div class="mini-card"><h3>Reading the ledger</h3><p>Prompt = input + cache read + cache write. Total = prompt + output.</p><p class="note">The parent ledger includes forwarded child usage. Child reports below are independent views and are never added to this total again.</p></div></div>${split}${models}${renderUsageRecords(usage.items)}</section>`;
}

function renderContext(report: SessionReport): string {
	const context = report.context;
	const usage = context.usage;
	const host = usage
		? `${valueOrDash(usage.tokens === null ? undefined : formatTokens(usage.tokens))} / ${formatTokens(usage.contextWindow)} tokens · ${formatPercent(usage.percent)} of window`
		: "Unavailable for this session";
	const segments = context.estimatedTotal
		? context.categories
				.filter((category) => (category.tokens ?? 0) > 0)
				.map(
					(category) =>
						`<div class="composition-segment cat-${category.id}" style="width:${(((category.tokens ?? 0) / context.estimatedTotal) * 100).toFixed(3)}%" title="${CATEGORY_LABELS[category.id]}: ${formatTokens(category.tokens ?? 0)}"></div>`,
				)
				.join("")
		: "";
	const rows = context.categories
		.map((category) => {
			const share =
				category.tokens === null || context.estimatedTotal === 0
					? "—"
					: formatPercent((category.tokens / context.estimatedTotal) * 100);
			return `<tr><td><span class="legend-swatch cat-${category.id}"></span>${CATEGORY_LABELS[category.id]}</td><td class="num">${category.tokens === null ? "—" : formatTokens(category.tokens)}</td><td class="num">${share}</td></tr>`;
		})
		.join("");
	return `<section><h2>Current context</h2><div class="mini-card"><h3>Host context usage</h3><p>${host}</p><p class="note">Host usage uses the latest applicable provider usage plus trailing estimates. Unknown after compaction until the next response.</p></div><h3>Estimated composition</h3>${segments ? `<div class="composition" role="img" aria-label="Estimated context composition">${segments}</div>` : `<div class="empty">No estimated context content</div>`}<div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Estimated tokens</th><th class="num">Share</th></tr></thead><tbody>${rows}</tbody></table></div><p class="note">Composition is estimated from the current projection and is not rescaled to provider totals. — means unknown, not zero.</p></section>`;
}

function eventPosition(items: readonly UsageLedgerItem[], eventTimestamp: string): number {
	if (items.length === 0) return 0;
	const time = Date.parse(eventTimestamp);
	if (!Number.isFinite(time)) return 0;
	const index = items.findIndex((item) => Date.parse(item.timestamp) >= time);
	return index < 0 ? items.length - 1 : index;
}

function renderTimeline(report: SessionReport): string {
	if (report.usage.items.length === 0) {
		return `<section><h2>Recorded usage timeline</h2><div class="empty">No recorded model usage</div>${renderTiming(report)}</section>`;
	}
	const items = report.usage.items;
	const width = Math.max(720, items.length * 14 + 20);
	const height = 200;
	const baseline = 160;
	const chartHeight = 130;
	const maxTotal = Math.max(
		1,
		...items.map((item) =>
			Math.max(0, item.usage.input + item.usage.cacheRead + item.usage.cacheWrite + item.usage.output),
		),
	);
	const points = items.map((item, index) => {
		const x = 10 + index * 14;
		let y = baseline;
		const bars = SERIES.map((series) => {
			const value = Math.max(0, series.value(item));
			if (value === 0) return "";
			const barHeight = (value / maxTotal) * chartHeight;
			y -= barHeight;
			return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="10" height="${barHeight.toFixed(2)}" class="${series.className}"><title>${escapeHtml(series.label)}: ${formatTokens(value)}</title></rect>`;
		});
		return `<g class="usage-point" data-entry-id="${escapeHtml(item.entryId)}"><title>${escapeHtml(item.source)} · ${formatTokens(item.usage.input + item.usage.cacheRead + item.usage.cacheWrite + item.usage.output)} tokens · ${formatCost(item.usage.cost.total)}</title>${bars.join("")}</g>`;
	});
	const markers = report.events.map((event) => {
		const index = eventPosition(items, event.timestamp);
		const x = 15 + index * 14;
		return `<line class="timeline-event" data-event-id="${escapeHtml(event.id)}" x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="10" y2="170"><title>${escapeHtml(event.label)}</title></line>`;
	});
	return `<section><h2>Recorded usage timeline</h2><div class="legend">${SERIES.map((series) => `<span><span class="legend-swatch ${series.className}"></span>${series.label}</span>`).join("")}<span><span class="legend-swatch" style="background:#f2d46b"></span>Context event</span></div><div class="timeline-scroll"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Recorded model usage timeline"><desc>Each group is one recorded usage item. Dashed lines are context events. Details are available in the tables below.</desc><line x1="10" x2="${(width - 10).toFixed(2)}" y1="${baseline}" y2="${baseline}" stroke="#2a3852" /><text x="10" y="185">Maximum: ${formatTokens(maxTotal)} tokens</text>${points.join("")}${markers.join("")}</svg></div>${renderTiming(report)}</section>`;
}

function renderTiming(report: SessionReport): string {
	const timing = report.timing;
	return `<div class="grid-2"><div class="mini-card"><h3>Timing</h3><p>Wall time: ${formatDuration(timing.wallTimeMs)}</p><p>Cumulative model time: ${formatDuration(timing.modelTimeMs)}${timing.modelTimeIncomplete ? " (partial)" : ""}</p><p>Cumulative tool time: ${formatDuration(timing.toolTimeMs)}${timing.toolTimeEstimated ? " (estimated)" : ""}</p></div><div class="mini-card"><h3>Range</h3><p>First: ${escapeHtml(formatTimestamp(timing.startedAt))}</p><p>Last: ${escapeHtml(formatTimestamp(timing.endedAt))}</p><p class="note">Cumulative durations can overlap when work runs in parallel.</p></div></div>`;
}

function statusBadge(status: string): string {
	const className =
		status === "ok" || status === "completed"
			? "badge-ok"
			: status === "error" || status === "cancelled"
				? "badge-error"
				: "badge-warn";
	return `<span class="badge ${className}">${escapeHtml(status)}</span>`;
}

function renderActivity(report: SessionReport): string {
	const activity = report.activity;
	const tools = activity.tools.length
		? `<h3>Tools</h3><div class="table-wrap"><table><thead><tr><th>Tool</th><th>Scope</th><th class="num">Calls</th><th class="num">OK</th><th class="num">Errors</th><th class="num">Missing</th><th class="num">Unfinished</th><th class="num">Cumulative time</th></tr></thead><tbody>${activity.tools
				.map(
					(tool) =>
						`<tr><td>${escapeHtml(tool.name)}</td><td>${tool.nested ? "nested" : "top-level"}</td><td class="num">${tool.calls}</td><td class="num">${tool.ok}</td><td class="num">${tool.errors}</td><td class="num">${tool.missing}</td><td class="num">${tool.unfinished}</td><td class="num">${formatDuration(tool.durationMs)}</td></tr>`,
				)
				.join("")}</tbody></table></div>`
		: `<div class="empty">No tool activity</div>`;
	const executions = activity.executions.length
		? `<details class="activity-details"><summary>Tool execution records (${activity.executions.length})</summary><div class="table-wrap"><table><thead><tr><th>ID</th><th>Tool</th><th>Status</th><th>Time</th><th class="num">Duration</th></tr></thead><tbody>${activity.executions
				.slice(0, DETAIL_LIMIT)
				.map(
					(execution) =>
						`<tr class="execution-row"><td><code>${escapeHtml(execution.id)}</code></td><td>${escapeHtml(execution.name)}${execution.nested ? " (nested)" : ""}</td><td>${statusBadge(execution.status)}</td><td>${escapeHtml(formatTimestamp(execution.timestamp))}</td><td class="num">${execution.durationMs === undefined ? "—" : formatDuration(execution.durationMs)}${execution.durationEstimated ? " (est.)" : ""}</td></tr>`,
				)
				.join("")}</tbody></table></div>${omissionText(Math.max(0, activity.executions.length - DETAIL_LIMIT))}</details>`
		: "";
	const files = activity.files.length
		? `<h3>Files</h3><div class="table-wrap"><table><thead><tr><th>Path</th><th class="num">Read</th><th class="num">Written</th><th class="num">Edited</th><th class="num">Searched</th><th class="num">+Lines</th><th class="num">−Lines</th></tr></thead><tbody>${activity.files
				.slice(0, DETAIL_LIMIT)
				.map(
					(file) =>
						`<tr><td><code>${escapeHtml(file.path)}</code></td><td class="num">${file.read}</td><td class="num">${file.written}</td><td class="num">${file.edited}</td><td class="num">${file.searched}</td><td class="num">${file.addedLines}</td><td class="num">${file.removedLines}</td></tr>`,
				)
				.join("")}</tbody></table></div>${omissionText(Math.max(0, activity.files.length - DETAIL_LIMIT))}`
		: `<h3>Files</h3><div class="empty">No file activity</div>`;
	const commands = activity.commands.length
		? `<h3>Commands</h3><div class="table-wrap"><table><thead><tr><th>Command</th><th>Source</th><th>Status</th><th class="num">Exit</th><th class="num">Duration</th></tr></thead><tbody>${activity.commands
				.slice(0, DETAIL_LIMIT)
				.map(
					(command) =>
						`<tr><td><code>${escapeHtml(clipText(command.command, COMMAND_LIMIT))}</code></td><td>${escapeHtml(command.source)}${command.nested ? " (nested)" : ""}</td><td>${statusBadge(command.status)}</td><td class="num">${valueOrDash(command.exitCode)}</td><td class="num">${command.durationMs === undefined ? "—" : formatDuration(command.durationMs)}${command.durationEstimated ? " (est.)" : ""}</td></tr>`,
				)
				.join("")}</tbody></table></div>${omissionText(Math.max(0, activity.commands.length - DETAIL_LIMIT))}`
		: `<h3>Commands</h3><div class="empty">No command activity</div>`;
	return `<section><h2>Activity</h2>${tools}${executions}${files}${commands}<p class="note">Line changes are argument-based estimates. Command output and tool result bodies are not included.</p></section>`;
}

function renderEvents(report: SessionReport): string {
	if (report.events.length === 0)
		return `<section><h2>Context events</h2><div class="empty">No context events</div></section>`;
	return `<section><h2>Context events</h2><div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Details</th><th>Target</th><th class="num">Tokens before</th></tr></thead><tbody>${report.events
		.slice(0, DETAIL_LIMIT)
		.map(
			(event) =>
				`<tr><td>${escapeHtml(formatTimestamp(event.timestamp))}</td><td>${escapeHtml(event.type)}</td><td>${escapeHtml(event.label)}</td><td><code>${valueOrDash(event.targetId)}</code></td><td class="num">${event.tokensBefore === undefined ? "—" : formatTokens(event.tokensBefore)}</td></tr>`,
		)
		.join("")}</tbody></table></div>${omissionText(Math.max(0, report.events.length - DETAIL_LIMIT))}</section>`;
}

function renderSubagents(report: InsightReport): string {
	if (report.subagents.length === 0)
		return `<section><h2>Subagents</h2><div class="empty">No subagents discovered</div></section>`;
	return `<section><h2>Subagents</h2>${report.subagents
		.map((child, index) => {
			const agent = child.agent;
			return `<details class="subagent-card" id="subagent-${index}"><summary><span>${escapeHtml(agent.description)}</span>${statusBadge(agent.status)}</summary><div class="subagent-body"><div class="hero-meta"><span><strong>ID:</strong> ${escapeHtml(agent.id)}</span><span><strong>Type:</strong> ${escapeHtml(agent.type)}</span><span><strong>Model:</strong> ${valueOrDash(agent.modelName ?? child.report.metadata.model)}</span><span><strong>File:</strong> <code>${escapeHtml(agent.filePath)}</code></span><span><strong>Started:</strong> ${escapeHtml(formatTimestamp(agent.startedAt))}</span><span><strong>Completed:</strong> ${escapeHtml(formatTimestamp(agent.completedAt))}</span></div>${renderUsageSection(child.report, false)}${renderContext(child.report)}${renderTimeline(child.report)}${renderActivity(child.report)}${renderEvents(child.report)}${child.report.warnings.length ? `<div class="warnings"><h3>Child warnings</h3><ul>${child.report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}</div></details>`;
		})
		.join(
			"",
		)}<p class="note">Untracked means there is no completion record: the child may be running, foreground, completed without a record, or interrupted.</p></section>`;
}

function renderWarnings(report: InsightReport): string {
	if (report.warnings.length === 0) return "";
	return `<section class="warnings"><h2>Warnings</h2><ul>${report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></section>`;
}

function renderDataNotes(): string {
	return `<section><h2>Data notes & privacy</h2><p>Usage and activity aggregate all session entries, including compacted history and other branches. Current composition uses only the active compacted projection with context edits applied.</p><p>Timeline values come from recorded usage. Composition values are estimates. Child totals are not added to the parent ledger a second time.</p><p><strong>Review before sharing.</strong> This report omits prompt, response, tool-result and command-output bodies, but still contains working directories, file paths, command text, model names and child descriptions.</p></section>`;
}

export function renderInsightHtml(report: InsightReport): string {
	const title = report.metadata.name ?? `Session ${report.metadata.id}`;
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Session Insight — ${escapeHtml(title)}</title><style>${REPORT_CSS}</style></head><body><header><h1>Session Insight</h1><p>${escapeHtml(title)}</p><div class="hero-meta"><span><strong>Session:</strong> <code>${escapeHtml(report.metadata.id)}</code></span><span><strong>Generated:</strong> ${escapeHtml(report.generatedAt)}</span><span><strong>Model:</strong> ${valueOrDash(report.metadata.model)}</span><span><strong>Thinking:</strong> ${valueOrDash(report.metadata.thinkingLevel)}</span><span><strong>Working directory:</strong> <code>${escapeHtml(report.metadata.cwd)}</code></span><span><strong>Session file:</strong> <code>${valueOrDash(report.metadata.filePath)}</code></span></div></header><main>${renderWarnings(report)}${renderKpis(report)}${renderUsageSection(report, true)}${renderContext(report)}${renderTimeline(report)}${renderSubagents(report)}${renderActivity(report)}${renderEvents(report)}${renderDataNotes()}</main><footer>Generated locally by pi-context-insight. Standalone HTML with no scripts or external resources.</footer></body></html>`;
}
