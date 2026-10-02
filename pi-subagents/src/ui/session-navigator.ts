/**
 * session-navigator.ts — The `/subagents:sessions` command: pick a subagent and
 * read its transcript through Pi's own per-entry session components.
 *
 * SDK/TUI consumer half of native session navigation. The unit-testable core
 * (selection, sourcing) lives in `session-navigation.ts`; this module wires that
 * core to the command picker and a read-only scrollable overlay. The per-entry
 * component tree lives in `transcript-body.ts` (incremental, mirrors Pi's own
 * `renderSessionContext`/`updateContent` lifecycle); this module owns the
 * viewport: scroll state, chrome, the sync throttle, and the line cache.
 *
 * The overlay is strictly read-only — steering stays in the `steer_subagent` tool
 * and the widget. It consumes a `TranscriptSource`, so the evicted-agent-source
 * follow-up swaps the source without touching the body or the overlay.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type MarkdownTheme,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentConfigLookup } from "../config/agent-types";
import type { EvictedSubagent } from "../lifecycle/subagent-manager";
import { describeActivity, type Theme } from "../ui/display";
import { TranscriptBody } from "../ui/transcript-body";
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
 * Minimum interval between two body syncs for a live (streaming) source.
 *
 * A running agent emits many events per second (text deltas, tool calls). Each
 * event can change a message — or only the activity indicator — and every change
 * ends in a line-cache rebuild. Coalescing bursts into at most one sync per tick
 * keeps the overlay responsive while still streaming.
 */
const SYNC_THROTTLE_MS = 120;

/**
 * Read-only scrollable transcript overlay.
 *
 * Two caches keep it responsive even for long, live-streaming transcripts:
 *
 *   - `body` (a `TranscriptBody`) is synced only when the source changes, and
 *     syncs are *throttled* — a burst of streaming events coalesces into at most
 *     one sync per `SYNC_THROTTLE_MS`, and the sync itself touches only the
 *     messages that changed, so markdown/tool rendering never re-runs for the
 *     whole transcript on every token.
 *   - `renderedLines` caches the laid-out, width-wrapped lines. `render()` and
 *     `handleInput()` read the cache (O(1) slice / length) instead of
 *     re-rendering the whole container on every frame and every keystroke.
 *
 * The cache is invalidated (`linesDirty`) whenever the body changed, and
 * recomputed lazily at the width it was requested at. This class owns scroll
 * state, chrome, and the running-agent streaming indicator; per-entry component
 * mapping and lifecycle live in `transcript-body.ts`.
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
	private readonly modelName?: string;
	private readonly thinking?: string;
	private readonly body: TranscriptBody;

	/** Throttle bookkeeping for coalescing live-source syncs. */
	private syncTimer: ReturnType<typeof setTimeout> | undefined;
	private lastSyncAt = 0;

	/** Cached laid-out lines + the width they were computed at; recomputed lazily when `linesDirty`. */
	private renderedLines: string[] = [];
	private renderedWidth = -1;
	/** Width of the last layout, kept across `invalidate()` so a keystroke cannot pick the wrong one. */
	private lastRenderWidth = -1;
	private linesDirty = true;
	/** Running-agent indicator baked into `renderedLines` — invalidates the cache when it changes. */
	private renderedIndicator = "";

	constructor({ tui, theme, source, done, cwd, markdownTheme, modelName, thinking }: TranscriptOverlayOptions) {
		this.tui = tui;
		this.theme = theme;
		this.source = source;
		this.done = done;
		this.modelName = modelName;
		this.thinking = thinking;
		this.body = new TranscriptBody({
			tui,
			cwd,
			markdownTheme,
			getToolDefinition: (name) => source.getToolDefinition(name),
		});
		this.body.sync(source.getMessages());
		// Seed `lastSyncAt` far in the past so the first source-change event
		// always syncs immediately (leading-edge throttle). The constructor
		// already materialized the snapshot at construction time, but the source
		// may have accumulated events between construction and subscription —
		// that first sync surfaces them without delay. Subsequent events inside
		// the throttle window are coalesced into a single trailing sync.
		this.lastSyncAt = 0;
		this.unsubscribe = source.subscribe(() => this.scheduleSync());
	}

	// fallow-ignore-next-line unused-class-member
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.closed = true;
			this.done(undefined);
			return;
		}

		const totalLines = this.getRenderedLines(this.layoutWidth()).length;
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
		this.body.invalidate();
		this.linesDirty = true;
		this.renderedWidth = -1;
	}

	// fallow-ignore-next-line unused-class-member
	dispose(): void {
		this.closed = true;
		if (this.syncTimer) {
			clearTimeout(this.syncTimer);
			this.syncTimer = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
	}

	// ---- Private ----

	/**
	 * Inner width the laid-out line cache belongs to.
	 *
	 * The overlay is rendered by TUI at its *own* width (90% of the terminal),
	 * not at the terminal width, so the scroll math must reuse the width the
	 * cache was laid out at — otherwise every keystroke misses the cache and
	 * re-lays out the whole transcript. Falls back to the terminal width before
	 * the first layout.
	 */
	private layoutWidth(): number {
		return this.lastRenderWidth > 0 ? this.lastRenderWidth : this.innerWidth();
	}

	/** Terminal-width-derived inner width — used before the first layout has happened. */
	private innerWidth(): number {
		return Math.max(0, this.tui.terminal.columns - 4);
	}

	private viewportHeight(): number {
		const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
		return Math.max(MIN_VIEWPORT, maxRows - CHROME_LINES);
	}

	/**
	 * Coalesce a burst of source-change events into at most one body sync
	 * per `SYNC_THROTTLE_MS`. The first event after an idle gap syncs
	 * immediately (so a freshly-picked agent paints without delay); subsequent
	 * events inside the gap are merged into a single trailing sync.
	 */
	private scheduleSync(): void {
		if (this.closed) return;
		const now = Date.now();
		const elapsed = now - this.lastSyncAt;
		if (elapsed >= SYNC_THROTTLE_MS) {
			this.doSync();
			return;
		}
		if (this.syncTimer) return; // a trailing sync is already pending
		this.syncTimer = setTimeout(() => {
			this.syncTimer = undefined;
			this.doSync();
		}, SYNC_THROTTLE_MS - elapsed);
	}

	/** Invalidate the line cache when the sync changed anything, then request a paint. */
	private doSync(): void {
		if (this.closed) return;
		this.lastSyncAt = Date.now();
		const outcome = this.body.sync(this.source.getMessages());
		if (outcome.appended + outcome.refreshed + outcome.rebuilt > 0) this.linesDirty = true;
		this.tui.requestRender();
	}

	/**
	 * Return the laid-out content lines at `innerW`, recomputing the cache only
	 * when the body or indicator changed (`linesDirty`) or the width changed.
	 * Cheap O(1) on the hot path (every render frame and every keystroke).
	 */
	private getRenderedLines(innerW: number): string[] {
		if (innerW <= 0) return [];
		if (!this.linesDirty && this.renderedWidth === innerW) {
			// The running-agent indicator lives outside the message list (`activeTools`,
			// streamed preview, and the status flip when the agent finishes), so no
			// event necessarily marks the cache dirty. Re-check it here, where every
			// frame and every keystroke reads the cache, and it self-heals.
			if (this.indicatorLine() === this.renderedIndicator) return this.renderedLines;
		}
		this.renderedLines = this.buildContentLines(innerW);
		this.renderedWidth = innerW;
		this.lastRenderWidth = innerW;
		this.linesDirty = false;
		return this.renderedLines;
	}

	/**
	 * Lay out the materialized transcript plus the running-agent indicator.
	 *
	 * Over-wide lines are truncated where they are *displayed* (in `render`), not
	 * here: truncating every line of the transcript on each layout was an O(whole
	 * transcript) pass just to show a viewport of it.
	 */
	private buildContentLines(innerW: number): string[] {
		if (innerW <= 0) return [];
		const lines = this.body.render(innerW);
		this.renderedIndicator = this.indicatorLine();
		if (this.renderedIndicator) {
			lines.push("", this.renderedIndicator);
		}
		return lines;
	}

	/** Running-agent indicator line, or "" when the source is not streaming. */
	private indicatorLine(): string {
		const streaming = this.source.streaming();
		return streaming ? `◍ ${describeActivity(streaming.activeTools, streaming.responseText)}` : "";
	}
}

