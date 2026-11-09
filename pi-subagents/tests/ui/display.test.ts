import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../../src/types";
import { describeActivity } from "../../src/ui/display";

const noTools = new Map<string, string>();

function assistant(content: unknown[]): SessionMessage {
	return { role: "assistant", content } as unknown as SessionMessage;
}

describe("describeActivity", () => {
	it("describes running tools ahead of text", () => {
		const tools = new Map([["k", "bash"]]);
		expect(describeActivity(tools, assistant([{ type: "text", text: "ignored" }]))).toBe("running command…");
	});

	it("uses the first non-empty line of the message text", () => {
		expect(describeActivity(noTools, assistant([{ type: "text", text: "\n\n  first line  \nsecond" }]))).toBe(
			"first line",
		);
	});

	it("truncates a long first line at 60 characters", () => {
		const long = "x".repeat(80);
		const out = describeActivity(noTools, assistant([{ type: "text", text: long }]));
		expect(out).toBe(`${"x".repeat(60)}…`);
	});

	it("falls back to thinking when the message carries no text", () => {
		expect(describeActivity(noTools, assistant([{ type: "thinking", thinking: "hmm" }]))).toBe("thinking…");
		expect(describeActivity(noTools, assistant([{ type: "toolCall", id: "t", name: "read", arguments: {} }]))).toBe(
			"thinking…",
		);
	});

	it("falls back to thinking without a message", () => {
		expect(describeActivity(noTools, undefined)).toBe("thinking…");
		expect(describeActivity(noTools)).toBe("thinking…");
	});
});
