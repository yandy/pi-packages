/**
 * transcript-body.ts — Incremental materialization of a subagent transcript.
 *
 * Owns the per-entry component tree the `/subagents:sessions` overlay renders.
 * Pi's own interactive mode materializes each session entry once and then updates
 * the affected component in place (`AssistantMessageComponent.updateContent`,
 * `ToolExecutionComponent.updateArgs`/`updateResult`), rebuilding only after a
 * compaction. This module mirrors that lifecycle for the read-only overlay:
 * `sync()` diffs the source's message list against what is already materialized
 * and touches only the messages that changed, so a streaming agent costs one
 * message refresh per event instead of a full transcript rebuild.
 *
 * Rendering (scroll state, chrome, line cache) stays in the overlay; the body
 * only answers "what components does this message list produce?".
 */

import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	type ToolDefinition,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component, type MarkdownTheme, Spacer, type TUI } from "@earendil-works/pi-tui";
import type { SessionMessage } from "../types";

// ─────────────────────────────────────────────────────────────────────────────

/** Dependencies the per-entry component tree needs from the SDK/TUI environment. */
export interface TranscriptRenderOptions {
	tui: TUI;
	cwd: string;
	markdownTheme: MarkdownTheme;
	getToolDefinition: (name: string) => ToolDefinition | undefined;
}

/** What one `sync()` changed, so callers can skip line-cache invalidation when nothing did. */
export interface TranscriptSyncOutcome {
	/** Messages materialized for the first time. */
	readonly appended: number;
	/** Existing entries whose content was updated in place (streaming tail). */
	readonly refreshed: number;
	/** Entries dropped after the transcript diverged (their replacements count as `appended`). */
	readonly rebuilt: number;
}

/** A materialized tool component plus the tool name it was built for (the renderer is name-bound). */
interface MaterializedTool {
	readonly name: string;
	readonly component: ToolExecutionComponent;
}

/** One materialized message plus the components it contributed, in render order. */
interface MaterializedEntry {
	/** The message as last materialized — refreshed in place when it mutates. */
	message: SessionMessage;
	/** Assistant text/thinking component, when the message produced one. */
	assistant?: AssistantMessageComponent;
	/** Tool components created by this message's tool calls, keyed by call id (with the name they were built for). */
	readonly tools: Map<string, MaterializedTool>;
	/** Children contributed to the container, in add order. */
	readonly children: Component[];
}

/** Message roles that pi mutates in place while streaming (everything else is immutable once emitted). */
const REFRESHABLE_ROLES = new Set(["assistant", "toolResult"]);

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Materialized component tree for one transcript, updated incrementally.
 *
 * Not a `Component` itself: the overlay needs the *lines* plus its own chrome and
 * scroll state, so the body exposes `render(width)` as a plain line producer.
 */
export class TranscriptBody {
	private readonly container = new Container();
	/** One entry per materialized message, index-aligned with the source's message list. */
	private readonly entries: MaterializedEntry[] = [];
	/** Tool components by tool-call id; each result message is applied to the component its call created. */
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	/** Fingerprint of the tail message's rendered content — detects an in-place streaming mutation. */
	private tailFingerprint = "";

	constructor(private readonly opts: TranscriptRenderOptions) {}

	/**
	 * Diff `messages` against what is materialized and update only what changed.
	 *
	 * Three kinds of change are recognized:
	 *   - append: the source grew (the common case for a live agent);
	 *   - refresh: the tail message was mutated in place (streaming text, more
	 *     tool calls, a resolved tool result) — its components are reused;
	 *   - rebuild: the transcript diverged (compaction, branch switch, edited
	 *     message) — everything from the divergence point is dropped and
	 *     re-materialized, mirroring pi's `rebuildChatFromMessages`.
	 */
	sync(messages: readonly SessionMessage[]): TranscriptSyncOutcome {
		let shared = this.sharedPrefix(messages);
		let refreshed = 0;

		// A divergence at the tail keeps its components: pi rewrites the streaming
		// assistant message in place, so the same entry is refreshed rather than
		// rebuilt (which would re-render every tool output of that message).
		if (shared < this.entries.length && this.isRefreshableTail(messages, shared)) {
			this.refreshEntry(this.entries[shared] as MaterializedEntry, messages[shared] as SessionMessage);
			shared++;
			refreshed++;
		}

		const rebuilt = shared < this.entries.length ? this.dropEntriesFrom(shared) : 0;

		let appended = 0;
		for (let i = this.entries.length; i < messages.length; i++) {
			this.appendEntry(messages[i] as SessionMessage);
			appended++;
		}

		// Same length, same identities: the only thing that can have changed is the
		// tail message's content, streamed into the object pi already pushed.
		if (appended === 0 && rebuilt === 0 && refreshed === 0 && messages.length > 0) {
			const tail = messages[messages.length - 1] as SessionMessage;
			if (this.tailFingerprint !== fingerprintOf(tail)) {
				const entry = this.entries[messages.length - 1] as MaterializedEntry;
				this.refreshEntry(entry, tail);
				refreshed++;
			}
		}

		return { appended, refreshed, rebuilt };
	}

	/** Laid-out lines for every materialized message. */
	render(width: number): string[] {
		return this.container.render(width);
	}

	/** Drop cached layout inside every materialized component (theme or width change). */
	invalidate(): void {
		this.container.invalidate();
	}

	// ---- Materialization ----

	/** Longest prefix of messages that is still the exact object it was materialized from. */
	private sharedPrefix(messages: readonly SessionMessage[]): number {
		const limit = Math.min(this.entries.length, messages.length);
		let shared = 0;
		while (shared < limit && this.entries[shared]?.message === messages[shared]) shared++;
		return shared;
	}

	/**
	 * True when the divergence at `shared` is a streaming rewrite of the tail
	 * message (same role) rather than the transcript being replaced.
	 */
	private isRefreshableTail(messages: readonly SessionMessage[], shared: number): boolean {
		const entry = this.entries[shared];
		const message = messages[shared];
		if (!entry || !message) return false;
		if (shared !== this.entries.length - 1) return false;
		return entry.message.role === message.role && REFRESHABLE_ROLES.has(message.role);
	}

	/** Update the tail entry in place, reusing every component it already owns. */
	private refreshEntry(entry: MaterializedEntry, message: SessionMessage): void {
		if (message.role === "assistant") {
			entry.assistant?.updateContent(message);
			this.syncToolCalls(entry, message);
		} else if (message.role === "toolResult") {
			this.pendingTools.get(message.toolCallId)?.updateResult(message);
		}
		entry.message = message;
		this.tailFingerprint = fingerprintOf(message);
	}

	/** Materialize one message's components, appending them to the container. */
	private appendEntry(message: SessionMessage): void {
		const entry: MaterializedEntry = { message, tools: new Map(), children: [] };
		switch (message.role) {
			case "assistant": {
				const assistant = new AssistantMessageComponent(message, false, this.opts.markdownTheme);
				entry.assistant = assistant;
				this.addChild(entry, assistant);
				this.syncToolCalls(entry, message);
				break;
			}
			case "toolResult": {
				this.pendingTools.get(message.toolCallId)?.updateResult(message);
				break;
			}
			case "user": {
				this.appendUserComponents(entry, message.content);
				break;
			}
			case "bashExecution": {
				const bash = new BashExecutionComponent(message.command, this.opts.tui, message.excludeFromContext);
				if (message.output) bash.appendOutput(message.output);
				bash.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
				this.addChild(entry, bash);
				break;
			}
			case "compactionSummary": {
				this.addChild(entry, new Spacer(1));
				const summary = new CompactionSummaryMessageComponent(message, this.opts.markdownTheme);
				summary.setExpanded(true);
				this.addChild(entry, summary);
				break;
			}
			case "branchSummary": {
				this.addChild(entry, new Spacer(1));
				const summary = new BranchSummaryMessageComponent(message, this.opts.markdownTheme);
				summary.setExpanded(true);
				this.addChild(entry, summary);
				break;
			}
		}
		this.entries.push(entry);
		this.tailFingerprint = fingerprintOf(message);
	}

	/**
	 * Create (or update) the tool component of every tool call in an assistant
	 * message. A tool call that appears mid-stream is appended after the message's
	 * earlier children, matching pi's own ordering.
	 */
	private syncToolCalls(entry: MaterializedEntry, message: SessionMessage): void {
		if (message.role !== "assistant") return;
		const present = new Set<string>();
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			present.add(content.id);
			const existing = entry.tools.get(content.id);
			if (existing && existing.name === content.name) {
				existing.component.updateArgs(content.arguments);
				continue;
			}
			// A call can vanish or change tool in an in-place rewrite of the tail
			// message, so the reconciled set — not just additions — is what renders.
			if (existing) this.dropTool(entry, content.id);
			this.addTool(entry, content.id, content.name, content.arguments);
		}
		for (const id of entry.tools.keys()) {
			if (!present.has(id)) this.dropTool(entry, id);
		}
	}

	/** Materialize one tool-call component and register it for its result. */
	private addTool(entry: MaterializedEntry, id: string, name: string, args: unknown): void {
		const component = new ToolExecutionComponent(
			name,
			id,
			args,
			{ showImages: false },
			this.opts.getToolDefinition(name),
			this.opts.tui,
			this.opts.cwd,
		);
		entry.tools.set(id, { name, component });
		this.pendingTools.set(id, component);
		this.addChild(entry, component);
	}

	/** Drop one tool-call component (its call disappeared or changed tool). */
	private dropTool(entry: MaterializedEntry, id: string): void {
		const materialized = entry.tools.get(id);
		if (!materialized) return;
		entry.tools.delete(id);
		this.pendingTools.delete(id);
		this.removeChild(entry, materialized.component);
	}

	/** Render a user message (skill block + text) into the container, mirroring pi. */
	private appendUserComponents(entry: MaterializedEntry, content: UserMessageContent): void {
		const text = userMessageText(content);
		if (!text) return;
		if (this.container.children.length > 0) this.addChild(entry, new Spacer(1));

		const skillBlock = parseSkillBlock(text);
		if (!skillBlock) {
			this.addChild(entry, new UserMessageComponent(text, this.opts.markdownTheme));
			return;
		}
		const skill = new SkillInvocationMessageComponent(skillBlock, this.opts.markdownTheme);
		skill.setExpanded(true);
		this.addChild(entry, skill);
		if (skillBlock.userMessage) {
			this.addChild(entry, new Spacer(1));
			this.addChild(entry, new UserMessageComponent(skillBlock.userMessage, this.opts.markdownTheme));
		}
	}

	/** Attach a child to both the container and the entry that owns it. */
	private addChild(entry: MaterializedEntry, child: Component): void {
		entry.children.push(child);
		this.container.addChild(child);
	}

	/** Detach a child from both the container and the entry that owns it. */
	private removeChild(entry: MaterializedEntry, child: Component): void {
		const index = entry.children.indexOf(child);
		if (index !== -1) entry.children.splice(index, 1);
		this.container.removeChild(child);
	}

	/**
	 * Drop every entry from `index` on, removing its children. Returns how many
	 * entries were dropped — the caller re-materializes the tail.
	 */
	private dropEntriesFrom(index: number): number {
		const dropped = this.entries.splice(index);
		for (const entry of dropped) {
			for (const child of entry.children) this.container.removeChild(child);
			for (const id of entry.tools.keys()) this.pendingTools.delete(id);
		}
		const tail = this.entries[this.entries.length - 1];
		this.tailFingerprint = tail ? fingerprintOf(tail.message) : "";
		return dropped.length;
	}
}

// ── Fingerprints ───────────────────────────────────────────────────────────────

/**
 * Content fingerprint that changes whenever a message would render differently.
 *
 * Only ever stored for the tail message: pi emits every earlier message once and
 * never mutates it (compaction replaces the list instead, which identity-diffing
 * catches). Values — not lengths — are captured, so an edit that keeps the byte
 * count identical still registers.
 */
function fingerprintOf(message: SessionMessage): string {
	switch (message.role) {
		case "bashExecution":
			return `bashExecution\u0000${message.command}\u0000${message.output}`;
		case "branchSummary":
			return `branchSummary\u0000${message.summary}`;
		case "compactionSummary":
			return `compactionSummary\u0000${message.summary}`;
		case "assistant":
			// `stopReason`/`errorMessage` drive the aborted/error footer lines, and an
			// extension's `message_end` replacement can flip them on a message that
			// keeps its object identity.
			return `assistant\u0000${message.stopReason ?? ""}\u0000${message.errorMessage ?? ""}\u0000${contentFingerprint(message.content)}`;
		case "toolResult":
			// `isError` picks the success/error background, `toolName` the renderer.
			return `toolResult\u0000${message.toolCallId}\u0000${message.toolName}\u0000${message.isError}\u0000${contentFingerprint(message.content)}`;
		default:
			return `${message.role}\u0000${contentFingerprint(message.content)}`;
	}
}

/** Fingerprint a message body; non-array shapes degrade to their string form instead of throwing. */
function contentFingerprint(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content);
	return content.map(fingerprintOfBlock).join("\u0001");
}

/** Fingerprint one content block; unknown block types (e.g. images) only contribute their type. */
function fingerprintOfBlock(block: { type: string }): string {
	const value = block as {
		type: string;
		text?: string;
		thinking?: string;
		id?: string;
		name?: string;
		arguments?: unknown;
	};
	switch (block.type) {
		case "text":
			return `text:${value.text ?? ""}`;
		case "thinking":
			return `thinking:${value.thinking ?? ""}`;
		case "toolCall":
			return `toolCall:${value.id ?? ""}:${value.name ?? ""}:${JSON.stringify(value.arguments ?? null)}`;
		default:
			return block.type;
	}
}

// ── User message helpers ───────────────────────────────────────────────────────

/** Content shape of a user message as the SDK emits it. */
type UserMessageContent = string | readonly { type: string; text?: string }[];

/** Concatenate the text blocks of a user message's content (mirrors pi). */
function userMessageText(content: UserMessageContent): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}
