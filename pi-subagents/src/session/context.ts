/**
 * context.ts — Extract parent conversation context for subagent inheritance.
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type { SessionContext } from "../types";

/**
 * Minimal structural types for session branch entries consumed by buildParentContext.
 * `getBranch()` returns `unknown[]` in SessionContext (ISP), so we cast to these
 * local shapes instead of coupling to the SDK's SessionEntry type.
 */
type MessageEntry = {
  type: "message";
  message: { role: string; content: string | { type: string }[] };
};
type CompactionEntry = { type: "compaction"; summary?: string };
type BranchEntry = MessageEntry | CompactionEntry | { type: string };

/** Type predicate: narrow an unknown content block to TextContent. */
function isTextContent(c: unknown): c is TextContent {
  return typeof c === "object" && c !== null && (c as { type: string }).type === "text";
}

/** Extract text from a message content block array. */
export function extractText(content: unknown[]): string {
  return content
    .filter(isTextContent)
    .map((c) => c.text)
    .join("\n");
}

/** Format a message entry (user/assistant); returns undefined for roles to skip. */
function formatMessageEntry(entry: MessageEntry): string | undefined {
  const msg = entry.message;
  const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
  if (!text.trim()) return undefined;
  if (msg.role === "user") return `[User]: ${text.trim()}`;
  if (msg.role === "assistant") return `[Assistant]: ${text.trim()}`;
  return undefined; // skip toolResult and other roles
}

/** Format a compaction entry; returns undefined when no summary is present. */
function formatCompactionEntry(entry: CompactionEntry): string | undefined {
  return entry.summary ? `[Summary]: ${entry.summary}` : undefined;
}

/** Dispatch a branch entry to the appropriate formatter. */
function formatBranchEntry(entry: BranchEntry): string | undefined {
  if (entry.type === "message") return formatMessageEntry(entry as MessageEntry);
  if (entry.type === "compaction") return formatCompactionEntry(entry as CompactionEntry);
  return undefined;
}

/**
 * Build a text representation of the parent conversation context.
 * Used when inherit_context is true to give the subagent visibility
 * into what has been discussed/done so far.
 */
export function buildParentContext(ctx: SessionContext): string {
  const entries = ctx.sessionManager.getBranch();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- getBranch() may return undefined at runtime despite its type
  if (!entries || entries.length === 0) return "";

  const parts = (entries as BranchEntry[])
    .map(formatBranchEntry)
    .filter((p): p is string => p !== undefined);

  if (parts.length === 0) return "";

  return `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.

${parts.join("\n\n")}

---
# Your Task (below)
`;
}
