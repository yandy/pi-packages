import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionMessage } from "../../src/types";
import { TranscriptBody } from "../../src/ui/transcript-body";

// Pi's per-entry components read the global interactive theme; Pi initializes it
// at startup before any command runs. Tests must initialize it explicitly.
beforeAll(() => initTheme(undefined, false));

function mockTui(): TUI {
	return { terminal: { rows: 40, columns: 80 }, requestRender: vi.fn() } as unknown as TUI;
}

function userMessage(text: string): SessionMessage {
	return { role: "user", content: text } as unknown as SessionMessage;
}

function assistantMessage(text: string, toolCall?: { id: string; name: string; arguments: unknown }): SessionMessage {
	const content: unknown[] = [{ type: "text", text }];
	if (toolCall) content.push({ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments });
	return { role: "assistant", content, stopReason: toolCall ? "toolUse" : "stop" } as unknown as SessionMessage;
}

function toolResultMessage(toolCallId: string, body: string, toolName = "read", isError = false): SessionMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: body }],
		isError,
	} as unknown as SessionMessage;
}

/** Track how many tool components the body materializes (one lookup per component). */
function makeTracker() {
	const getToolDefinition = vi.fn(() => undefined);
	const body = new TranscriptBody({
		tui: mockTui(),
		cwd: "/test/cwd",
		markdownTheme: getMarkdownTheme(),
		getToolDefinition,
	});
	return { body, getToolDefinition };
}

const READ_CALL = { id: "tc-1", name: "read", arguments: { path: "/src/big.ts" } };
const BODY = Array.from({ length: 80 }, (_, l) => `line ${l} of file content`).join("\n");

describe("TranscriptBody", () => {
	it("materializes the transcript on the first sync", () => {
		const { body } = makeTracker();
		const outcome = body.sync([userMessage("hello"), assistantMessage("world")]);

		expect(outcome).toEqual({ appended: 2, refreshed: 0, rebuilt: 0 });
		expect(body.render(80).join("\n")).toContain("hello");
		expect(body.render(80).join("\n")).toContain("world");
	});

	it("reports no change when the same messages are synced again", () => {
		const messages = [userMessage("hello"), assistantMessage("world")];
		const { body, getToolDefinition } = makeTracker();

		body.sync(messages);
		expect(body.sync(messages)).toEqual({ appended: 0, refreshed: 0, rebuilt: 0 });
		expect(getToolDefinition).not.toHaveBeenCalled();
	});

	it("materializes only the appended messages", () => {
		const messages = [assistantMessage("first", READ_CALL)];
		const { body, getToolDefinition } = makeTracker();

		body.sync(messages);
		expect(getToolDefinition).toHaveBeenCalledTimes(1);

		messages.push(userMessage("next"));
		expect(body.sync(messages)).toEqual({ appended: 1, refreshed: 0, rebuilt: 0 });
		// The already-materialized tool component was reused, not rebuilt.
		expect(getToolDefinition).toHaveBeenCalledTimes(1);
	});

	it("refreshes an assistant message that grew in place", () => {
		const message = assistantMessage("first", READ_CALL);
		const messages = [message];
		const { body, getToolDefinition } = makeTracker();

		body.sync(messages);
		(message.content as unknown[]).push({ type: "text", text: "second" });

		expect(body.sync(messages)).toEqual({ appended: 0, refreshed: 1, rebuilt: 0 });
		expect(body.render(80).join("\n")).toContain("second");
		// The tool component of the growing message survived the refresh.
		expect(getToolDefinition).toHaveBeenCalledTimes(1);
	});

	it("applies a tool result to the tool component of a refreshed message", () => {
		const call = { id: "tc-bash", name: "bash", arguments: { command: "seq 80" } };
		const message = assistantMessage("first", call);
		const messages = [message];
		const { body, getToolDefinition } = makeTracker();

		body.sync(messages);
		(message.content as unknown[]).push({ type: "text", text: "second" });
		body.sync(messages); // tail refresh keeps the tool component pending

		messages.push(toolResultMessage(call.id, BODY, "bash"));
		expect(body.sync(messages)).toEqual({ appended: 1, refreshed: 0, rebuilt: 0 });

		expect(getToolDefinition).toHaveBeenCalledTimes(1);
		// The result reached the component the refresh kept alive. `bash` renders a
		// preview of its output when collapsed, so the text is observable here;
		// `read` would render nothing and make this assertion vacuous.
		expect(body.render(80).join("\n")).toContain("line 79 of file content");
	});

	it("re-materializes from the divergence point when the transcript is replaced", () => {
		const first = [userMessage("old one"), assistantMessage("old two")];
		const { body } = makeTracker();
		body.sync(first);

		const replacement = [userMessage("new one"), assistantMessage("new two")];
		expect(body.sync(replacement)).toEqual({ appended: 2, refreshed: 0, rebuilt: 2 });

		const rendered = body.render(80).join("\n");
		expect(rendered).toContain("new one");
		expect(rendered).not.toContain("old two");
	});

	it("renders a skill invocation user message", () => {
		// Moved verbatim from the overlay when the body module split out: a user
		// message carrying a `<skill>` block renders as a skill component plus the
		// operator's actual message.
		const skillMessage = [
			"<skill name=\"pdf\" location=\"/skills/pdf\">",
			"How to use the pdf skill.",
			"</skill>",
			"",
			"now summarize the doc",
		].join("\n");
		const { body } = makeTracker();

		body.sync([userMessage(skillMessage)]);

		const rendered = body.render(80).join("\n");
		expect(rendered).toContain("pdf");
		expect(rendered).toContain("now summarize the doc");
	});

	it("renders tool results collapsed by default", () => {
		const { body } = makeTracker();
		body.sync([assistantMessage("reading", READ_CALL), toolResultMessage(READ_CALL.id, BODY)]);

		const rendered = body.render(80).join("\n");
		expect(rendered).toContain("read");
		// Pi's collapsed read renderer shows no output at all (read.js: collapsed → "").
		expect(rendered).not.toContain("line 79 of file content");
	});
});

// ── Correctness invariant: incremental rendering == from-scratch rendering ─────
//
// Pi mutates the tail message in place (`_replaceMessageInPlace`) both for
// streaming updates and for `message_end` replacements that extensions return.
// Earlier messages keep their object identity, so the body's tail-refresh path
// is the one that runs. Whatever transition a live session goes through, the
// rendered lines must equal a from-scratch materialization of the final list.

/** A transition: a first sync of `before`, an optional in-place tail rewrite, then a sync of `after`. */
interface Transition {
	readonly before: readonly SessionMessage[];
	readonly after: readonly SessionMessage[];
	mutate?: () => void;
}

const LONG_OUTPUT = Array.from({ length: 12 }, (_, i) => `body line ${i}`).join("\n");

function transition(name: string, build: () => Transition): [string, () => Transition] {
	return [name, build];
}

/** Shared prefix so only the tail differs — the shape a live session has. */
function withTail(tail: SessionMessage): { messages: SessionMessage[] } {
	return { messages: [userMessage("hi"), tail] };
}

function withToolResult(): { messages: SessionMessage[]; replace: (id: string, name: string, body: string, isError: boolean) => SessionMessage } {
	const assistant = assistantMessage("go", { id: "tc-1", name: "bash", arguments: { command: "ls" } });
	const result = toolResultMessage("tc-1", LONG_OUTPUT, "bash");
	return { messages: [userMessage("hi"), assistant, result] };
}

const transitions: [string, () => Transition][] = [
	transition("append assistant + tool result", () => {
		const prefix = [userMessage("hi")];
		return {
			before: [...prefix],
			after: [
				...prefix,
				assistantMessage("working", { id: "tc-1", name: "bash", arguments: { command: "ls" } }),
				toolResultMessage("tc-1", LONG_OUTPUT, "bash"),
			],
		};
	}),
	transition("tail assistant text grows in place", () => {
		const { messages } = withTail(assistantMessage("first"));
		return {
			before: messages,
			after: messages,
			mutate: () => {
				(messages[1]?.content as unknown[]).push({ type: "text", text: " second" });
			},
		};
	}),
	transition("tool call appears mid-stream", () => {
		const { messages } = withTail(assistantMessage("thinking"));
		return {
			before: messages,
			after: messages,
			mutate: () => {
				(messages[1]?.content as unknown[]).push({ type: "toolCall", id: "tc-9", name: "bash", arguments: { command: "pwd" } });
			},
		};
	}),
	transition("tool call arguments grow in place", () => {
		const { messages } = withTail(assistantMessage("go", { id: "tc-2", name: "bash", arguments: { command: "l" } }));
		return {
			before: messages,
			after: messages,
			mutate: () => {
				const content = messages[1]?.content as { arguments: unknown }[];
				content[1]!.arguments = { command: "ls -la" };
			},
		};
	}),
	transition("tail rewritten with fewer tool calls", () => {
		const { messages } = withTail(assistantMessage("go", { id: "tc-a", name: "bash", arguments: { command: "ls" } }));
		(messages[1]?.content as unknown[]).push({ type: "toolCall", id: "tc-b", name: "read", arguments: { path: "/f.ts" } });
		return {
			before: messages,
			after: messages,
			mutate: () => {
				// The rewrite dropped the second tool call; the incremental body must
				// drop its component too, or the transcript shows a ghost tool block.
				messages[1]!.content = [
					{ type: "text", text: "go" },
					{ type: "toolCall", id: "tc-a", name: "bash", arguments: { command: "ls" } },
				] as never;
			},
		};
	}),
	transition("tail rewritten with a different tool-call id", () => {
		const { messages } = withTail(assistantMessage("go", { id: "tc-1", name: "read", arguments: { path: "/f.ts" } }));
		return {
			before: messages,
			after: messages,
			mutate: () => {
				messages[1]!.content = [{ type: "toolCall", id: "tc-2", name: "bash", arguments: { command: "ls" } }] as never;
			},
		};
	}),
	transition("same tool-call id, different tool name", () => {
		const { messages } = withTail(assistantMessage("go", { id: "tc-1", name: "read", arguments: { path: "/f.ts" } }));
		return {
			before: messages,
			after: messages,
			mutate: () => {
				messages[1]!.content = [{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } }] as never;
			},
		};
	}),
	transition("tool call removed from the tail assistant message", () => {
		const { messages } = withTail(assistantMessage("go", { id: "tc-1", name: "read", arguments: { path: "/f.ts" } }));
		return {
			before: messages,
			after: messages,
			mutate: () => {
				messages[1]!.content = [{ type: "text", text: "go" }] as never;
			},
		};
	}),
	transition("tool result isError flips in place", () => {
		const { messages } = withToolResult();
		const result = messages[2]!;
		return {
			before: messages,
			after: messages,
			mutate: () => {
				(result as { isError: boolean }).isError = true;
			},
		};
	}),
	transition("assistant stopReason becomes error in place", () => {
		const { messages } = withTail(assistantMessage("partial"));
		return {
			before: messages,
			after: messages,
			mutate: () => {
				const tail = messages[1]! as { stopReason: string; errorMessage?: string };
				tail.stopReason = "error";
				tail.errorMessage = "boom";
			},
		};
	}),
	transition("transcript replaced (compaction)", () => ({
		before: [userMessage("old"), assistantMessage("old reply")],
		after: [userMessage("new"), assistantMessage("new reply")],
	})),
	transition("transcript shrinks to empty", () => ({
		before: [userMessage("a"), assistantMessage("b")],
		after: [],
	})),
	transition("compaction summary prepended while the tail is kept by reference", () => {
		const kept = [userMessage("kept"), assistantMessage("kept reply")];
		return {
			before: kept,
			after: [
				{ role: "compactionSummary", summary: "earlier turns", tokensBefore: 10, timestamp: 1 } as unknown as SessionMessage,
				...kept,
			],
		};
	}),
];

describe("TranscriptBody — incremental rendering matches a from-scratch build", () => {
	for (const [name, build] of transitions) {
		it(name, () => {
			const { before, after, mutate } = build();
			const incremental = makeTracker().body;
			incremental.sync(before);
			mutate?.();
			incremental.sync(after);

			const scratch = makeTracker().body;
			scratch.sync(after);

			expect(incremental.render(80)).toEqual(scratch.render(80));
		});
	}
});
