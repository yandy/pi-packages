import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSummary, instanceName } from "../src/summary.js";

describe("instanceName", () => {
	it("prefers the session name", () => {
		expect(instanceName("review", "/tmp/proj", 123)).toBe("review (pid 123)");
	});

	it("falls back to the cwd basename when unnamed", () => {
		expect(instanceName(undefined, join("/tmp", "proj"), 123)).toBe("proj (pid 123)");
	});

	it("falls back to the cwd basename for an empty session name", () => {
		expect(instanceName("", join("/tmp", "proj"), 1)).toBe("proj (pid 1)");
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

	it("does not truncate text exactly at maxLen", () => {
		const entries = [{ type: "message", message: { role: "assistant", content: "a".repeat(160) } }];
		expect(extractSummary(entries)).toBe("a".repeat(160));
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
