import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	extractSummary,
	formatDuration,
	instanceContext,
	instanceName,
	withContext,
} from "../src/summary.js";

describe("instance identity", () => {
	it("prefers the session name", () => {
		expect(instanceName("review", "/tmp/proj")).toBe("review");
	});

	it("falls back to the cwd basename when unnamed or empty", () => {
		expect(instanceName(undefined, join("/tmp", "proj"))).toBe("proj");
		expect(instanceName("", join("/tmp", "proj"))).toBe("proj");
	});

	it("keeps project, prompt kind, and pid in the context line", () => {
		expect(instanceContext("review", join("/tmp", "proj"), 123, "confirm")).toBe(
			"proj · confirm · pid 123",
		);
	});

	it("omits a duplicate or missing project name", () => {
		expect(instanceContext(undefined, join("/tmp", "proj"), 123)).toBe("pid 123");
		expect(instanceContext("proj", join("/tmp", "proj"), 123)).toBe("pid 123");
	});

	it("places the subject before context and handles an empty subject", () => {
		expect(withContext("All done.", "pid 123")).toBe("All done.\npid 123");
		expect(withContext("", "pid 123")).toBe("pid 123");
	});
});

describe("formatDuration", () => {
	it.each([
		[0, "<1s"],
		[499, "<1s"],
		[500, "1s"],
		[10000, "10s"],
		[60000, "1m"],
		[83000, "1m 23s"],
		[3600000, "1h"],
		[3660000, "1h 1m"],
	])("formats %d ms as %s", (duration, expected) => {
		expect(formatDuration(duration)).toBe(expected);
	});
});

describe("extractSummary", () => {
	it("joins text blocks of the last assistant message and skips trailing non-assistant entries", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "First part." },
						{ type: "toolCall", id: "1", name: "bash", arguments: {} },
						{ type: "text", text: "Second part." },
					],
				},
			},
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
		];
		expect(extractSummary(entries)).toBe("First part. Second part.");
	});

	it("collapses whitespace and newlines", () => {
		const entries = [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "line one\n\n  line   two\tend" }] },
			},
		];
		expect(extractSummary(entries)).toBe("line one line two end");
	});

	it("supports string content", () => {
		const entries = [{ type: "message", message: { role: "assistant", content: "plain text" } }];
		expect(extractSummary(entries)).toBe("plain text");
	});

	it("truncates at the default 160 chars with an ellipsis", () => {
		const text = "a".repeat(200);
		const entries = [{ type: "message", message: { role: "assistant", content: text } }];
		const summary = extractSummary(entries);
		expect(summary).toHaveLength(161);
		expect(summary).toBe(`${"a".repeat(160)}…`);
	});

	it("honours a custom maxLen", () => {
		const entries = [{ type: "message", message: { role: "assistant", content: "abcdefghijklmnop" } }];
		expect(extractSummary(entries, 10)).toBe("abcdefghij…");
	});

	it("does not split grapheme clusters", () => {
		const emoji = "👨‍👩‍👧‍👦";
		const entries = [{ type: "message", message: { role: "assistant", content: emoji.repeat(4) } }];
		expect(extractSummary(entries, 2)).toBe(`${emoji.repeat(2)}…`);
	});

	it("prefers a nearby sentence or word boundary", () => {
		const sentence = [{ type: "message", message: { role: "assistant", content: "First result. More implementation details follow" } }];
		const words = [{ type: "message", message: { role: "assistant", content: "alpha beta gamma delta" } }];
		expect(extractSummary(sentence, 26)).toBe("First result.…");
		expect(extractSummary(words, 15)).toBe("alpha beta…");
	});

	it("keeps a sentence boundary exactly at maxLen", () => {
		const entries = [{ type: "message", message: { role: "assistant", content: "aa bb cc。dd" } }];
		expect(extractSummary(entries, 9)).toBe("aa bb cc。…");
	});

	it("does not truncate text exactly at maxLen", () => {
		const entries = [{ type: "message", message: { role: "assistant", content: "a".repeat(160) } }];
		expect(extractSummary(entries)).toBe("a".repeat(160));
	});

	it("strips markdown markup while keeping the readable text", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "## Result\n- Updated `foo.ts` and **fixed** the *bug*\n- See [the docs](https://example.com) for details",
						},
					],
				},
			},
		];
		expect(extractSummary(entries)).toBe("Result Updated foo.ts and fixed the bug See the docs for details");
	});

	it("strips ordered list markers and keeps math with single asterisks readable", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: "1. first step\n2. second step\nresult: 2*3 = 6",
				},
			},
		];
		expect(extractSummary(entries)).toBe("first step second step result: 2*3 = 6");
	});

	it("returns empty for no entries, no assistant, or no text blocks", () => {
		expect(extractSummary([])).toBe("");
		expect(extractSummary([{ type: "message", message: { role: "user", content: "hi" } }])).toBe("");
		expect(
			extractSummary([
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash" }] },
				},
			]),
		).toBe("");
		expect(extractSummary([{ type: "custom", customType: "x", content: "y" }])).toBe("");
		expect(extractSummary([null, 42, "junk"])).toBe("");
	});
});
