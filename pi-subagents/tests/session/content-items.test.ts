import type { TextContent, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { extractAssistantContent, getToolCallName } from "../../src/session/content-items";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal valid TextContent fixture. */
const text = (t: string): TextContent => ({ type: "text", text: t });

/** Minimal valid ToolCall fixture. */
const toolCall = (name: string): ToolCall => ({
  type: "toolCall",
  id: "call_1",
  name,
  arguments: {},
});

// ── getToolCallName ───────────────────────────────────────────────────────────

describe("getToolCallName", () => {
  it("returns the tool name", () => {
    expect(getToolCallName(toolCall("Bash"))).toBe("Bash");
  });

  it("returns 'unknown' for non-toolCall type", () => {
    expect(getToolCallName({ type: "text" })).toBe("unknown");
  });
});

// ── extractAssistantContent ───────────────────────────────────────────────────

describe("extractAssistantContent", () => {
  it("returns empty arrays for empty content", () => {
    expect(extractAssistantContent([])).toEqual({ textParts: [], toolNames: [] });
  });

  it("collects text items", () => {
    expect(extractAssistantContent([text("Hello"), text("World")])).toEqual({
      textParts: ["Hello", "World"],
      toolNames: [],
    });
  });

  it("collects toolCall items", () => {
    expect(extractAssistantContent([toolCall("Bash"), toolCall("Read")])).toEqual({
      textParts: [],
      toolNames: ["Bash", "Read"],
    });
  });

  it("collects mixed text and toolCall items", () => {
    const content = [text("Some analysis"), toolCall("Bash"), text("More text"), toolCall("Write")];
    expect(extractAssistantContent(content)).toEqual({
      textParts: ["Some analysis", "More text"],
      toolNames: ["Bash", "Write"],
    });
  });

  it("skips items with other types (e.g. thinking blocks)", () => {
    const thinking = { type: "thinking" };
    expect(extractAssistantContent([text("Before"), thinking, toolCall("Read")])).toEqual({
      textParts: ["Before"],
      toolNames: ["Read"],
    });
  });

  it("skips text items with empty text", () => {
    expect(extractAssistantContent([text(""), text("Real content")])).toEqual({
      textParts: ["Real content"],
      toolNames: [],
    });
  });
});
