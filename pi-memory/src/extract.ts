import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runHeadlessAgent } from "./agent-runner";
import type { ThinkLevel } from "./config";

export interface RunExtractOpts {
	model?: string;
	thinkLevel: ThinkLevel;
	memoryDir: string;
	messages: Array<{ role: string; content: string }>;
	maxContextTokens: number;
	modelRegistry: ModelRegistry;
	parentModel?: Model<any>;
	customTools?: ToolDefinition[];
}

/** Build extraction task prompt using memory tools instead of raw file I/O. */
export function buildExtractTask(
	memoryDir: string,
	messages: Array<{ role: string; content: string }>,
	maxTokens: number,
): string {
	const fromUser = messages.find((m) => m.role === "user");
	const fromAssistant = messages.findLast((m) => m.role === "assistant");
	const userText = fromUser?.content ?? "";
	const assistantText = fromAssistant?.content ?? "";

	const maxChars = maxTokens * 4;
	const truncatedUser = userText.slice(0, maxChars / 2);
	const truncatedAssistant = assistantText.slice(0, maxChars / 2);

	return [
		`You are a memory extraction agent. Your working directory is the memory directory at ${memoryDir}.`,
		"",
		"Analyze the conversation snippet below. If you find valuable learnings, persist them using the memory tools.",
		"",
		"You have three tools available:",
		"- memory_read: read existing topic files or entries to check for related memories",
		"- memory_search: search across all memory files for relevant existing entries",
		"- memory_add: persist a new memory entry to a topic file (creates the topic if new)",
		"",
		"Do NOT use file read/write/edit/ls tools. Only use memory_add, memory_read, and memory_search.",
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
		"- Use memory_read first to check for existing topic files on related subjects",
		"- Use memory_search to find overlapping or related memories before adding",
		"- Use descriptive, self-contained entry titles (only index lines are injected into future sessions)",
		'- Choose the appropriate type: user, feedback, project, reference (default "feedback")',
		"- Be concise but complete",
		"- If unsure, do NOT write anything",
		"",
		"=== Conversation ===",
		`User: ${truncatedUser}`,
		`Assistant: ${truncatedAssistant}`,
	].join("\n");
}

/** Fire-and-forget memory extraction. Does not await the headless agent. */
export async function runExtract(opts: RunExtractOpts): Promise<void> {
	if (opts.messages.length === 0) return;
	const task = buildExtractTask(opts.memoryDir, opts.messages, opts.maxContextTokens);
	// fire-and-forget: runner disposes internally via finally
	runHeadlessAgent({
		task,
		cwd: opts.memoryDir,
		modelRegistry: opts.modelRegistry,
		model: opts.model,
		parentModel: opts.parentModel,
		thinkLevel: opts.thinkLevel,
		maxTurns: 5,
		timeoutMs: 120_000,
		tools: [],
		customTools: opts.customTools ?? [],
	}).catch(() => {
		/* silently ignore extract errors */
	});
}
