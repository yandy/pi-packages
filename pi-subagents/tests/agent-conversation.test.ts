import { describe, expect, it } from "vitest";
import { getAgentConversation } from "../src/session/conversation";
import { createMockSession, toAgentSession } from "./helpers/mock-session";

describe("getAgentConversation", () => {
	it("formats user messages", () => {
		const session = createMockSession({
			messages: [{ role: "user", content: "hello world", timestamp: 1 }],
		});
		const result = getAgentConversation(toAgentSession(session));
		expect(result).toBe("[User]: hello world");
	});

	it("extracts text from user content array", () => {
		const session = createMockSession({
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "from array" }],
					timestamp: 1,
				},
			],
		});
		const result = getAgentConversation(toAgentSession(session));
		expect(result).toBe("[User]: from array");
	});

	it("skips empty user messages", () => {
		const session = createMockSession({
			messages: [{ role: "user", content: "   ", timestamp: 1 }],
		});
		const result = getAgentConversation(toAgentSession(session));
		expect(result).toBe("");
	});

	it("formats assistant messages with provider/model attribution", () => {
		const session = createMockSession({
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "hi there" }],
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					timestamp: 1,
				},
			],
		});
		const result = getAgentConversation(toAgentSession(session));
		expect(result).toBe("[Assistant (anthropic/claude-sonnet-4-20250514)]: hi there");
	});

	it("formats assistant messages with provider only", () => {
		const session = createMockSession({
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "response" }],
					provider: "openai",
					timestamp: 1,
				},
			],
		});
		const result = getAgentConversation(toAgentSession(session));
		expect(result).toBe("[Assistant (openai)]: response");
	});

	it("formats assistant messages with model only", () => {
		const session = createMockSession({
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "response" }],
					model: "gpt-4o",
					timestamp: 1,
				},
			],
		});
		const result = getAgentConversation(toAgentSession(session));
		expect(result).toBe("[Assistant (gpt-4o)]: response");
	});

	it("formats assistant messages without attribution when both missing", () => {
		const session = createMockSession({
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "response" }],
					timestamp: 1,
				},
			],
		});
		const result = getAgentConversation(toAgentSession(session));
		expect(result).toBe("[Assistant]: response");
	});

	it("formats tool calls", () => {
		const session = createMockSession({
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "read" }],
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					timestamp: 1,
				},
			],
		});
		const result = getAgentConversation(toAgentSession(session));
		expect(result).toBe("[Tool Calls]:\n  Tool: read");
	});

	it("formats tool results with truncation", () => {
		const longText = "x".repeat(300);
		const session = createMockSession({
			messages: [
				{
					role: "toolResult",
					toolName: "read",
					content: [{ type: "text", text: longText }],
					toolCallId: "tc1",
					isError: false,
					timestamp: 1,
				},
			],
		});
		const result = getAgentConversation(toAgentSession(session));
		expect(result).toBe(`[Tool Result (read)]: ${"x".repeat(200)}...`);
	});

	it("formats a full conversation with multiple messages", () => {
		const session = createMockSession({
			messages: [
				{ role: "user", content: "What is 2+2?", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "The answer is 4." }],
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					timestamp: 2,
				},
			],
		});
		const result = getAgentConversation(toAgentSession(session));
		expect(result).toBe("[User]: What is 2+2?\n\n[Assistant (anthropic/claude-sonnet-4-20250514)]: The answer is 4.");
	});

	it("returns empty string for no messages", () => {
		const session = createMockSession({ messages: [] });
		const result = getAgentConversation(toAgentSession(session));
		expect(result).toBe("");
	});
});
