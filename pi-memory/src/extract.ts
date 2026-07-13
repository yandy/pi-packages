import { getSubagentsService, type SubagentsService, type WorkspaceProvider } from "@yandy0725/pi-subagents";
import { access } from "node:fs/promises";

export interface RunExtractOpts {
	model: string;
	memoryDir: string;
	messages: Array<{ role: string; content: string }>;
	maxContextTokens: number;
	service?: SubagentsService;
}

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
		`You are a memory extraction agent. Your cwd is set to the memory directory at ${memoryDir}.`,
		"Analyze the conversation snippet below and decide if there are any learnings worth persisting across sessions.",
		"",
		"If you find valuable information, write it to the appropriate topic file in this directory.",
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

export async function runExtract(opts: RunExtractOpts): Promise<void> {
	if (opts.messages.length === 0) return;

	const service = opts.service ?? getSubagentsService();
	if (!service) return; // silently skip if no subagent service

	const model = opts.model === "auto" ? undefined : opts.model;
	const task = buildExtractTask(opts.memoryDir, opts.messages, opts.maxContextTokens);

	const provider: WorkspaceProvider = {
		async prepare(_ctx) {
			await access(opts.memoryDir).catch(() => {
				throw new Error(`Memory directory not found: ${opts.memoryDir}`);
			});
			return {
				cwd: opts.memoryDir,
				dispose: () => undefined,
			};
		},
	};
	service.registerWorkspaceProvider(provider);

	// Fire-and-forget spawn
	service.spawn("general-purpose", task, model ? { model } : {});
}
