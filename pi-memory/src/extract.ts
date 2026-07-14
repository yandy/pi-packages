import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./agent-runner";
import type { Model } from "@earendil-works/pi-ai";
import { runHeadlessAgent } from "./agent-runner";

export interface RunExtractOpts {
	model?: string;
	thinkLevel: ThinkingLevel;
	memoryDir: string;
	messages: Array<{ role: string; content: string }>;
	maxContextTokens: number;
	modelRegistry: ModelRegistry;
	parentModel?: Model<any>;
}

/** Build extraction task prompt.
 *  Session context strategy: only current turn (user + assistant messages).
 *  No conversation history — extraction is turn-scoped.
 *  Tool scope: file read/write only (cwd = memoryDir). */
export function buildExtractTask(
	memoryDir: string,
	messages: Array<{ role: string; content: string }>,
	maxTokens: number,
): string {
	// Find user and assistant messages for context
	const fromUser = messages.find((m) => m.role === "user");
	const fromAssistant = messages.findLast((m) => m.role === "assistant");
	const userText = fromUser?.content ?? "";
	const assistantText = fromAssistant?.content ?? "";

	// Truncate by maxTokens (rough estimate: ~4 chars/token)
	const maxChars = maxTokens * 4;
	const truncatedUser = userText.slice(0, maxChars / 2);
	const truncatedAssistant = assistantText.slice(0, maxChars / 2);

	return [
		`You are a memory extraction agent. Your cwd is the memory directory at ${memoryDir}.`,
		"",
		"Analyze the conversation snippet below. If you find valuable learnings, write them to topic files in this directory using ONLY file read/write/edit tools. Do NOT use bash, web search, or any other tools.",
		"The memory directory contains topic files with this frontmatter format:",
		"",
		"```yaml",
		"---",
		"name: Topic Name",
		"description: Brief summary for relevance matching",
		"type: feedback  # one of: user, feedback, project, reference",
		"updated: 2026-07-13",
		"---",
		"",
		"## Entry Title",
		"Entry content here.",
		"```",
		"",
		"And MEMORY.md index:",
		"- [Name](file.md) — one-line hook summary",
		"",
		"Worth remembering:",
		"- User preferences, coding style choices, tooling preferences",
		"- Project conventions, architecture decisions, naming patterns",
		"- Debugging insights, workarounds, gotchas discovered",
		'- "Always do X" / "Never do Y" rules',
		"- References to external systems or documentation",
		"",
		"NOT worth remembering:",
		"- One-time task instructions or ephemeral details",
		"- Code snippets or file paths derivable from the project",
		"- Information already captured in CLAUDE.md or AGENTS.md",
		"- Git history or recent changes",
		"",
		"When writing memories:",
		"- Use descriptive, self-contained entry titles (only index lines are injected into future sessions)",
		"- Choose the appropriate type: user, feedback, project, reference",
		'- Default type is "feedback"',
		"- Be concise but complete",
		"- If unsure, do NOT write anything",
		"- Use the write/edit tools to directly modify topic files and MEMORY.md",
		"",
		"=== Conversation ===",
		`User: ${truncatedUser}`,
		`Assistant: ${truncatedAssistant}`,
	].join("\n");
}

/** Fire-and-forget memory extraction. Errors silently caught. */
export async function runExtract(opts: RunExtractOpts): Promise<void> {
	if (opts.messages.length === 0) return;
	const task = buildExtractTask(opts.memoryDir, opts.messages, opts.maxContextTokens);
	runHeadlessAgent({
		task,
		cwd: opts.memoryDir,
		modelRegistry: opts.modelRegistry,
		model: opts.model,
		parentModel: opts.parentModel,
		thinkLevel: opts.thinkLevel,
		maxTurns: 5,
		timeoutMs: 120_000,
	}).catch(() => { /* silent */ });
}
