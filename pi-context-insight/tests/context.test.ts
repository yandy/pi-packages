import type { SystemMessage } from "@earendil-works/pi-ai";
import { estimateMessageTokens, estimateTextAndImageContentTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { SessionManager, type SessionProjection } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { analyzeContextProjection, type ContextCategoryId } from "../src/context";

function projection(messages: SessionProjection["messages"]): SessionProjection {
	return { entries: [], messages, thinkingLevel: "off", model: null };
}

function tokens(result: ReturnType<typeof analyzeContextProjection>, id: ContextCategoryId): number | null {
	const category = result.categories.find((entry) => entry.id === id);
	expect(category, `missing category ${id}`).toBeDefined();
	return category!.tokens;
}

describe("context composition", () => {
	it("splits system prompt and tool definitions without double counting", () => {
		const system: SystemMessage = {
			role: "system",
			content: "base prompt",
			sections: { rules: "rule text" },
			toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
			toolsRemoved: [{ name: "write" }],
			timestamp: 1,
		};
		const result = analyzeContextProjection(projection([system]));
		const toolTokens =
			estimateTextTokens(JSON.stringify(system.toolsAdded)) + estimateTextTokens(JSON.stringify(system.toolsRemoved));

		expect(tokens(result, "toolDefinitions")).toBe(toolTokens);
		expect(tokens(result, "system")).toBe(estimateMessageTokens(system) - toolTokens);
		expect(result.estimatedTotal).toBe(estimateMessageTokens(system));
		expect(result.complete).toBe(true);
	});

	it("classifies user, injected, compaction, bash and tool-result messages", () => {
		const userContent = [
			{ type: "text" as const, text: "hello" },
			{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
		];
		const result = analyzeContextProjection(
			projection([
				{ role: "user", content: userContent, timestamp: 1 },
				{ role: "custom", customType: "test", content: "injected", display: true, timestamp: 2 },
				{ role: "branchSummary", summary: "branch summary", fromId: "old", timestamp: 3 },
				{ role: "compactionSummary", summary: "compacted", tokensBefore: 100, timestamp: 4 },
				{ role: "bashExecution", command: "echo hi", output: "secret-output", exitCode: 0, cancelled: false, truncated: false, timestamp: 5 },
				{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 6 },
			]),
		);

		const expectedUser = estimateTextAndImageContentTokens(userContent) + estimateTextTokens("echo hi\nsecret-output");
		expect(tokens(result, "user")).toBe(expectedUser);
		expect(tokens(result, "injected")).toBe(estimateTextTokens("injected") + estimateTextTokens("branch summary"));
		expect(tokens(result, "compaction")).toBe(estimateTextTokens("compacted"));
		expect(tokens(result, "toolResults")).toBe(estimateTextAndImageContentTokens([{ type: "text", text: "result" }]));
		expect(JSON.stringify(result)).not.toContain("aGVsbG8=");
		expect(JSON.stringify(result)).not.toContain("secret-output");
	});

	it("splits assistant answers, reasoning and tool calls", () => {
		const args = { path: "a.ts" };
		const result = analyzeContextProjection(
			projection([
				{
					role: "assistant",
					content: [
						{ type: "text", text: "answer" },
						{ type: "thinking", thinking: "think" },
						{ type: "toolCall", id: "call-1", name: "read", arguments: args },
					],
					api: "anthropic-messages",
					provider: "p",
					model: "m",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
			]),
		);

		expect(tokens(result, "answers")).toBe(estimateTextTokens("answer"));
		expect(tokens(result, "reasoning")).toBe(estimateTextTokens("think"));
		expect(tokens(result, "toolCalls")).toBe(estimateTextTokens(`read${JSON.stringify(args)}`));
	});

	it("uses fallback prompt and marks missing tool definitions unknown", () => {
		const usage = { tokens: null, contextWindow: 200_000, percent: null };
		const result = analyzeContextProjection(projection([]), { usage, fallbackSystemPrompt: "fallback" });
		expect(tokens(result, "system")).toBe(estimateTextTokens("fallback"));
		expect(tokens(result, "toolDefinitions")).toBeNull();
		expect(result.estimatedTotal).toBe(estimateTextTokens("fallback"));
		expect(result.complete).toBe(false);
		expect(result.usage).toBe(usage);
		expect(result.warnings.join("\n")).toContain("Tool definitions");
	});

	it("returns zero known tokens for an empty projection", () => {
		const result = analyzeContextProjection(projection([]));
		expect(result.estimatedTotal).toBe(0);
		expect(result.categories.every((category) => category.tokens === 0 || category.tokens === null)).toBe(true);
		expect(result.warnings).toHaveLength(1);
	});

	it("honors compaction and later context edits in a real session projection", () => {
		const manager = SessionManager.inMemory("/project");
		manager.appendMessage({ role: "user", content: "sensitive-old", timestamp: 1 });
		manager.appendCompaction("compact-summary", null, 100);
		const removedId = manager.appendMessage({ role: "user", content: "remove-me", timestamp: 3 });
		const replacedId = manager.appendMessage({ role: "user", content: "keep-original", timestamp: 4 });
		manager.appendContextEdit(removedId, null);
		manager.appendContextEdit(replacedId, { content: "replacement" });

		const sessionProjection = manager.buildSessionProjection();
		const visible = JSON.stringify(sessionProjection.messages);
		expect(visible).toContain("compact-summary");
		expect(visible).toContain("replacement");
		expect(visible).not.toContain("sensitive-old");
		expect(visible).not.toContain("remove-me");
		expect(visible).not.toContain("keep-original");

		const result = analyzeContextProjection(sessionProjection);
		expect(tokens(result, "compaction")).toBe(estimateTextTokens("compact-summary"));
		expect(tokens(result, "user")).toBe(estimateTextTokens("replacement"));
	});
});
