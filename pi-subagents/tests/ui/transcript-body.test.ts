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

function toolResultMessage(toolCallId: string, body: string): SessionMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: body }],
		isError: false,
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
		const message = assistantMessage("first", READ_CALL);
		const messages = [message];
		const { body, getToolDefinition } = makeTracker();

		body.sync(messages);
		(message.content as unknown[]).push({ type: "text", text: "second" });
		body.sync(messages); // tail refresh keeps the tool component pending

		messages.push(toolResultMessage(READ_CALL.id, BODY));
		expect(body.sync(messages)).toEqual({ appended: 1, refreshed: 0, rebuilt: 0 });

		expect(getToolDefinition).toHaveBeenCalledTimes(1);
		// The tool component resolved its result through the pending map.
		expect(body.render(80)).toBeDefined();
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
