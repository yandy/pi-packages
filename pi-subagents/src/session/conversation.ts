/**
 * conversation.ts — Render a subagent session's messages as formatted text.
 *
 * Extracted from agent-runner.ts (issue #265) into the session domain, where the
 * other message-extraction helpers (content-items, context) live. Consumed by
 * the get_subagent_result tool's verbose output.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { extractAssistantContent } from "../session/content-items";
import { extractText } from "../session/context";

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const { textParts, toolNames } = extractAssistantContent(msg.content);
      const attribution = formatAttribution(msg);
      if (textParts.length > 0)
        parts.push(`[Assistant${attribution}]: ${textParts.join("\n")}`);
      if (toolNames.length > 0)
        parts.push(`[Tool Calls]:\n${toolNames.map((n) => `  Tool: ${n}`).join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}

/** Build a `(provider/model)` attribution suffix for assistant messages. */
function formatAttribution(msg: { provider?: string; model?: string }): string {
  const { provider, model } = msg;
  if (!provider && !model) return "";
  if (provider && model) return ` (${provider}/${model})`;
  return ` (${provider ?? model})`;
}
