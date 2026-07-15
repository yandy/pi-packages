import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runHeadlessAgent } from "./agent-runner";
import type { SessionPersistenceConfig, ThinkLevel } from "./config";

export interface RunExtractOpts {
	model?: string;
	thinkLevel: ThinkLevel;
	memoryDir: string;
	messages: Array<{ role: string; content: string }>;
	maxContextTokens: number;
	modelRegistry: ModelRegistry;
	parentModel?: Model<any>;
	sessionPersistence?: SessionPersistenceConfig;
	customTools?: ToolDefinition[];
	agentsMdBlocks?: string[];  // 新增
}

/** Build extraction task prompt using memory tools instead of raw file I/O. */
export function buildExtractTask(
	memoryDir: string,
	messages: Array<{ role: string; content: string }>,
	maxTokens: number,
	agentsMdBlocks: string[] = [],  // 新增
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
		"## Tools",
		"- ls — list files in the memory directory",
		"- read — read MEMORY.md and topic files to check for existing topics",
		"- memory_search — full-text search across all memory files for related entries",
		"- memory_add — persist a new memory entry to a topic file (creates the topic if new)",
		"",
		"Do NOT use 'bash', 'write', 'edit', or any other tools.",
		"",
		"## Workflow",
		"1. Use ls + read to survey existing topic files and MEMORY.md index.",
		"2. Use memory_search to check for overlapping or related entries.",
		"3. Use memory_add to write new memories — only if the information is novel and valuable.",
		"",
		"## What to Remember",
		"- Process rules: \"Always do X\" / \"Never do Y\" directives, workflow discipline, reporting standards, self-check habits — treat these as seriously as technical facts",
		"- User preferences: coding style, tool choices, naming conventions, workflow habits",
		"- Project conventions: architecture decisions, file organization, tech stack choices",
		"- Discoveries: debugging workarounds, gotchas, configuration quirks, undocumented behavior",
		"- References: external docs, APIs, or systems the user treats as important",
		"- AGENTS.md rules that were violated — extract for memory-level reinforcement (refer to the AGENTS.md content below)",
		"",
		"## What to Skip",
		"- One-time task instructions or ephemeral details",
		"- Code snippets or file paths derivable from the project",
		"- AGENTS.md rules that were followed without issue (refer to the AGENTS.md content below)",
		"- Git history or recent changes",
		"- Obvious or trivial observations",
		"",
		"## Memory Entry Guidelines",
		"- Entry titles must be self-contained and descriptive (only titles appear in future sessions' index)",
		'- Choose the appropriate type: user, feedback, project, or reference (default "feedback")',
		"- Be concise but complete — one clear point per entry",
		"- When in doubt, skip it",
		"",
		...(agentsMdBlocks.length > 0
			? ["## AGENTS.md Rules", ...agentsMdBlocks, ""]
			: []),
		"=== Conversation ===",
		`User: ${truncatedUser}`,
		`Assistant: ${truncatedAssistant}`,
	].join("\n");
}

/** Fire-and-forget memory extraction. Does not await the headless agent. */
export async function runExtract(opts: RunExtractOpts): Promise<void> {
	if (opts.messages.length === 0) return;
	const task = buildExtractTask(opts.memoryDir, opts.messages, opts.maxContextTokens, opts.agentsMdBlocks ?? []);
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

		tools: ["read", "ls"],
		customTools: opts.customTools ?? [],
		sessionPersistence: opts.sessionPersistence,
	}).catch(() => {
		/* silently ignore extract errors */
	});
}
