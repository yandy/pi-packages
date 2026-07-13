/**
 * session-navigator.ts — The `/subagents:sessions` command: pick a subagent and
 * read its transcript through Pi's own per-entry session components.
 *
 * SDK/TUI consumer half of native session navigation. The unit-testable core
 * (selection, sourcing) lives in `session-navigation.ts`; this module wires that
 * core to the command picker and a read-only scrollable overlay, and owns the
 * renderer — it mounts Pi's interactive components (`AssistantMessageComponent`,
 * `ToolExecutionComponent`, …) into a `Container`, mirroring Pi's own
 * `renderSessionContext` mapping. Rendering lives here, not in the pure module,
 * because the components require a `TUI`, `cwd`, and markdown theme.
 *
 * The overlay is strictly read-only — steering stays in the `steer_subagent` tool
 * and the widget. It consumes a `TranscriptSource`, so the evicted-agent-source
 * follow-up swaps the source without touching the renderer or the overlay.
 */

import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	getMarkdownTheme,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	type ToolDefinition,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type MarkdownTheme,
	matchesKey,
	Spacer,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentConfigLookup } from "../config/agent-types";
import type { EvictedSubagent } from "../lifecycle/subagent-manager";
import type { SessionMessage } from "../types";
import { describeActivity, type Theme } from "../ui/display";
import {
	fileSnapshotSource,
	listNavigableAgents,
	liveSource,
	type NavigableSubagent,
	type TranscriptSource,
} from "../ui/session-navigation";

// ─────────────────────────────────────────────────────────────────────────────

/** Chrome lines: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES = 6;
const MIN_VIEWPORT = 3;
const VIEWPORT_HEIGHT_PCT = 70;

/** Component factory shape Pi's `ui.custom` invokes to mount an overlay. */
export type OverlayComponentFactory<R> = (
	tui: TUI,
	theme: Theme,
	keybindings: unknown,
	done: (result: R) => void,
) => Component;

/** Narrow UI interface — only the `ctx.ui` methods the navigator calls. */
export interface SessionNavigatorUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, level: "info" | "warning" | "error"): void;
	custom<R>(component: OverlayComponentFactory<R>, options?: unknown): Promise<R>;
}

/** Parameters for one `/subagents:sessions` invocation. */
export interface SessionNavigatorParams {
	ui: SessionNavigatorUI;
	agents: readonly NavigableSubagent[];
	/** Descriptors of agents evicted by the cleanup sweep, sourced from disk when picked. */
	evicted: readonly EvictedSubagent[];
	registry: AgentConfigLookup;
	/** Working directory for tool-call rendering (relative path display). */
	cwd: string;
	/** Reads a persisted session file for the file-snapshot source. */
	readFile: (path: string) => string;
}

/** Options for the read-only transcript overlay. */
export interface TranscriptOverlayOptions {
	tui: TUI;
	theme: Theme;
	source: TranscriptSource;
	done: (result: undefined) => void;
	cwd: string;
	markdownTheme: MarkdownTheme;
	/** Short model name to show in the header, or undefined to omit. */
	modelName?: string;
	/** Thinking level to show alongside model name, or undefined to omit. */
	thinking?: string;
}

/**
 * Handler for the `/subagents:sessions` slash command.
 *
 * Lists navigable subagents, lets the operator pick one, and opens its transcript
 * read-only. Receives the agent snapshot (`manager.listAgents()`) rather than the
 * manager, so it stays a reactive consumer with no inbound call into the core.
 */
export class SessionNavigatorHandler {
	async handle({ ui, agents, evicted, registry, cwd, readFile }: SessionNavigatorParams): Promise<void> {
		const entries = listNavigableAgents(agents, evicted, registry);
		if (entries.length === 0) {
			ui.notify("No subagent sessions to view.", "info");
			return;
		}

		const choice = await ui.select(
			"Subagent sessions",
			entries.map((entry) => entry.label),
		);
		const entry = entries.find((candidate) => candidate.label === choice);
		if (!entry) return;

		let source: TranscriptSource;
		let modelName: string | undefined;
		let thinking: string | undefined;
		try {
			if (entry.kind === "live") {
				source = liveSource(entry.record);
				modelName = entry.record.modelName;
				thinking = entry.record.thinking;
			} else {
				source = fileSnapshotSource(entry.outputFile, readFile);
				modelName = entry.modelName;
				thinking = entry.thinking;
			}
		} catch {
			ui.notify("Could not read the session transcript file.", "error");
			return;
		}
		const markdownTheme = getMarkdownTheme();
		await ui.custom<undefined>(
			(tui, theme, _keybindings, done) =>
				new TranscriptOverlay({ tui, theme, source, done, cwd, markdownTheme, modelName, thinking }),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
			},
		);
	}
}

/**
 * Minimum interval between two component rebuilds for a live (streaming) source.
 *
 * A running agent emits many events per second (text deltas, tool calls). Without
 * throttling, each event rebuilt the whole component tree (markdown parsing
 * included) and re-rendered it — starving the event loop so keystrokes (arrows,
 * `q`) stopped responding. Coalescing bursts into at most one rebuild per tick
 * keeps the overlay responsive while still streaming.
 */
const REBUILD_THROTTLE_MS = 120;

/**
 * Read-only scrollable transcript overlay.
 *
 * Two caches keep it responsive even for long, live-streaming transcripts:
 *
 *   - `content` (a `Container` of Pi's per-entry components) is rebuilt only when
 *     the source changes, and rebuilds are *throttled* — a burst of streaming
 *     events coalesces into at most one rebuild per `REBUILD_THROTTLE_MS`, so
 *     markdown highlighting never re-runs on every token.
 *   - `renderedLines` caches the laid-out, width-wrapped lines. `render()` and
 *     `handleInput()` read the cache (O(1) slice / length) instead of
 *     re-rendering the whole container on every frame and every keystroke.
 *
 * The cache is invalidated (`linesDirty`) whenever the component tree changes,
 * and recomputed lazily at the current width. This class owns scroll state,
 * chrome, and the running-agent streaming indicator; the component mapping lives
 * in `buildTranscriptComponents`.
 */
export class TranscriptOverlay implements Component {
	private scrollOffset = 0;
	private autoScroll = true;
	private unsubscribe: (() => void) | undefined;
	private closed = false;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly source: TranscriptSource;
	private readonly done: (result: undefined) => void;
	private readonly cwd: string;
	private readonly markdownTheme: MarkdownTheme;
	private readonly modelName?: string;
	private readonly thinking?: string;
	private content: Container;

	/** Throttle bookkeeping for coalescing live-source rebuilds. */
	private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
	private lastRebuildAt = 0;

	/** Cached laid-out lines + the width they were computed at; recomputed lazily when `linesDirty`. */
	private renderedLines: string[] = [];
	private renderedWidth = -1;
	private linesDirty = true;

	constructor({ tui, theme, source, done, cwd, markdownTheme, modelName, thinking }: TranscriptOverlayOptions) {
		this.tui = tui;
		this.theme = theme;
		this.source = source;
		this.done = done;
		this.cwd = cwd;
		this.markdownTheme = markdownTheme;
		this.modelName = modelName;
		this.thinking = thinking;
		this.content = this.rebuild();
		// Seed `lastRebuildAt` far in the past so the first source-change event
		// always rebuilds immediately (leading-edge throttle). The constructor
		// already built `content` from the snapshot at construction time, but
		// the source may have accumulated events between construction and
		// subscription — that first rebuild surfaces them without delay.
		// Subsequent events inside the throttle window are coalesced into a
		// single trailing rebuild.
		this.lastRebuildAt = 0;
		this.unsubscribe = source.subscribe(() => this.scheduleRebuild());
	}

	// fallow-ignore-next-line unused-class-member
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.closed = true;
			this.done(undefined);
			return;
		}

		const totalLines = this.getRenderedLines(this.innerWidth()).length;
		const viewportHeight = this.viewportHeight();
		const maxScroll = Math.max(0, totalLines - viewportHeight);
		let scrolled = false;

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			// Streaming may add lines between handleInput and render,
			// making maxScroll larger; unconditionally disable autoScroll
			// so render() does not reset scrollOffset back to the bottom.
			this.autoScroll = false;
			scrolled = true;
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.autoScroll = false;
			scrolled = true;
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
			this.autoScroll = false;
			scrolled = true;
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
			this.autoScroll = false;
			scrolled = true;
		} else if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
			this.autoScroll = false;
			scrolled = true;
		} else if (matchesKey(data, "end")) {
			this.scrollOffset = maxScroll;
			this.autoScroll = true;
			scrolled = true;
		}

		if (scrolled) this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width < 6) return [];
		const th = this.theme;
		const innerW = width - 4;
		const lines: string[] = [];

		const pad = (s: string, len: number): string => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
		const row = (content: string): string =>
			`${th.fg("border", "│")} ${truncateToWidth(pad(content, innerW), innerW)} ${th.fg("border", "│")}`;
		const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
		const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
		const hrMid = row(th.fg("dim", "─".repeat(innerW)));

		lines.push(hrTop);
		const modelPart = this.modelName
			? this.thinking ? ` · ${this.modelName} (${this.thinking})` : ` · ${this.modelName}`
			: "";
		const title = modelPart ? `Subagent session${modelPart}` : "Subagent session";
		lines.push(row(th.bold(title)));
		lines.push(hrMid);

		const contentLines = this.getRenderedLines(innerW);
		const viewportHeight = this.viewportHeight();
		const maxScroll = Math.max(0, contentLines.length - viewportHeight);
		if (this.autoScroll) this.scrollOffset = maxScroll;
		const visibleStart = Math.min(this.scrollOffset, maxScroll);
		const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
		for (let i = 0; i < viewportHeight; i++) lines.push(row(visible[i] ?? ""));

		lines.push(hrMid);
		const scrollPct =
			contentLines.length <= viewportHeight
				? "100%"
				: `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
		const footerLeft = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
		const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn · end follow · q close");
		const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
		lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
		lines.push(hrBot);

		return lines;
	}

	// fallow-ignore-next-line unused-class-member
	invalidate(): void {
		this.content.invalidate();
		this.linesDirty = true;
		this.renderedWidth = -1;
	}

	// fallow-ignore-next-line unused-class-member
	dispose(): void {
		this.closed = true;
		if (this.rebuildTimer) {
			clearTimeout(this.rebuildTimer);
			this.rebuildTimer = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
	}

	// ---- Private ----

	private innerWidth(): number {
		return Math.max(0, this.tui.terminal.columns - 4);
	}

	private viewportHeight(): number {
		const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
		return Math.max(MIN_VIEWPORT, maxRows - CHROME_LINES);
	}

	/**
	 * Coalesce a burst of source-change events into at most one component rebuild
	 * per `REBUILD_THROTTLE_MS`. The first event after an idle gap rebuilds
	 * immediately (so a freshly-picked agent paints without delay); subsequent
	 * events inside the gap are merged into a single trailing rebuild.
	 */
	private scheduleRebuild(): void {
		if (this.closed) return;
		const now = Date.now();
		const elapsed = now - this.lastRebuildAt;
		if (elapsed >= REBUILD_THROTTLE_MS) {
			this.doRebuild();
			return;
		}
		if (this.rebuildTimer) return; // a trailing rebuild is already pending
		this.rebuildTimer = setTimeout(() => {
			this.rebuildTimer = undefined;
			this.doRebuild();
		}, REBUILD_THROTTLE_MS - elapsed);
	}

	/** Rebuild the component tree, invalidate the line cache, and request a paint. */
	private doRebuild(): void {
		if (this.closed) return;
		this.lastRebuildAt = Date.now();
		this.content = this.rebuild();
		this.linesDirty = true;
		this.tui.requestRender();
	}

	/**
	 * Return the laid-out content lines at `innerW`, recomputing the cache only
	 * when the component tree changed (`linesDirty`) or the width changed.
	 * Cheap O(1) on the hot path (every render frame and every keystroke).
	 */
	private getRenderedLines(innerW: number): string[] {
		if (innerW <= 0) return [];
		if (!this.linesDirty && this.renderedWidth === innerW) return this.renderedLines;
		this.renderedLines = this.buildContentLines(innerW);
		this.renderedWidth = innerW;
		this.linesDirty = false;
		return this.renderedLines;
	}

	private buildContentLines(innerW: number): string[] {
		if (innerW <= 0) return [];
		const lines = this.content.render(innerW);
		const streaming = this.source.streaming();
		if (streaming) {
			lines.push("", `◍ ${describeActivity(streaming.activeTools, streaming.responseText)}`);
		}
		return lines.map((l) => truncateToWidth(l, innerW));
	}

	private rebuild(): Container {
		return buildTranscriptComponents(this.source.getMessages(), {
			tui: this.tui,
			cwd: this.cwd,
			markdownTheme: this.markdownTheme,
			getToolDefinition: (name) => this.source.getToolDefinition(name),
		});
	}
}

/** Dependencies the per-entry component tree needs from the SDK/TUI environment. */
interface TranscriptRenderOptions {
	tui: TUI;
	cwd: string;
	markdownTheme: MarkdownTheme;
	getToolDefinition: (name: string) => ToolDefinition | undefined;
}

/**
 * Build a `Container` of Pi's per-entry components from a message snapshot,
 * mirroring Pi's own interactive-mode `renderSessionContext` mapping. Tool
 * results are matched to their tool-call components by id, exactly as Pi does.
 * `custom`-role messages are skipped — rendering them needs the child session's
 * message-renderer registry, which the navigator does not hold.
 */
function buildTranscriptComponents(messages: readonly SessionMessage[], opts: TranscriptRenderOptions): Container {
	const container = new Container();
	const pendingTools = new Map<string, ToolExecutionComponent>();
	for (const message of messages) {
		addMessageComponents(container, message, pendingTools, opts);
	}
	return container;
}

function addMessageComponents(
	container: Container,
	message: SessionMessage,
	pendingTools: Map<string, ToolExecutionComponent>,
	opts: TranscriptRenderOptions,
): void {
	switch (message.role) {
		case "assistant": {
			container.addChild(new AssistantMessageComponent(message, false, opts.markdownTheme));
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const tool = new ToolExecutionComponent(
					content.name,
					content.id,
					content.arguments,
					{ showImages: false },
					opts.getToolDefinition(content.name),
					opts.tui,
					opts.cwd,
				);
				tool.setExpanded(true);
				container.addChild(tool);
				pendingTools.set(content.id, tool);
			}
			break;
		}
		case "toolResult": {
			pendingTools.get(message.toolCallId)?.updateResult(message);
			pendingTools.delete(message.toolCallId);
			break;
		}
		case "user": {
			addUserComponents(container, message.content, opts.markdownTheme);
			break;
		}
		case "bashExecution": {
			const bash = new BashExecutionComponent(message.command, opts.tui, message.excludeFromContext);
			if (message.output) bash.appendOutput(message.output);
			bash.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
			container.addChild(bash);
			break;
		}
		case "compactionSummary": {
			container.addChild(new Spacer(1));
			const summary = new CompactionSummaryMessageComponent(message, opts.markdownTheme);
			summary.setExpanded(true);
			container.addChild(summary);
			break;
		}
		case "branchSummary": {
			container.addChild(new Spacer(1));
			const summary = new BranchSummaryMessageComponent(message, opts.markdownTheme);
			summary.setExpanded(true);
			container.addChild(summary);
			break;
		}
	}
}

/** Render a user message (skill block + text) into the container, mirroring Pi. */
function addUserComponents(
	container: Container,
	content: string | readonly { type: string; text?: string }[],
	markdownTheme: MarkdownTheme,
): void {
	const text = userMessageText(content);
	if (!text) return;
	if (container.children.length > 0) container.addChild(new Spacer(1));

	const skillBlock = parseSkillBlock(text);
	if (!skillBlock) {
		container.addChild(new UserMessageComponent(text, markdownTheme));
		return;
	}
	const skill = new SkillInvocationMessageComponent(skillBlock, markdownTheme);
	skill.setExpanded(true);
	container.addChild(skill);
	if (skillBlock.userMessage) {
		container.addChild(new Spacer(1));
		container.addChild(new UserMessageComponent(skillBlock.userMessage, markdownTheme));
	}
}

/** Concatenate the text blocks of a user message's content (mirrors Pi). */
function userMessageText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}
