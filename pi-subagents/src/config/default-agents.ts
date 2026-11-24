/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import type { AgentConfig } from "../types";

// Read-only exploration. The host's read-only tools plus `bash`: exploration leans
// on read-only shell commands (`git log`, `rg`), and the system prompt below forbids
// every write. A hardcoded list (rather than "all built-ins") keeps the capability
// a property of this agent instead of a snapshot of the host's tool set.
const EXPLORE_TOOL_NAMES = ["read", "bash", "grep", "find", "ls"];

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
	[
		"general-purpose",
		{
			name: "general-purpose",
			displayName: "Agent",
			description: "General-purpose agent for complex, multi-step tasks",
			// toolNames omitted — inherit the parent session's tools (the dispatch tools
			// are stripped after binding by the recursion guard), so the child matches
			// the caller instead of a package-local snapshot of tool names.
			// inheritContext / runInBackground omitted — strategy fields, callers decide per-call.
			// Setting them to false would lock callsite intent (see resolveAgentInvocationConfig in invocation-config.ts).
			systemPrompt: "",
			promptMode: "append",
			isDefault: true,
		},
	],
	[
		"Explore",
		{
			name: "Explore",
			displayName: "Explore",
			description: "Fast codebase exploration agent (read-only)",
			toolNames: EXPLORE_TOOL_NAMES,
			// model omitted — inherit the parent model, and let callers override it per call.
			// A hardcoded default would win over the `model` param and, when the exact
			// "provider/modelId" is not in the available set, fuzzy-match a different model.
			systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
- Make independent tool calls in parallel for efficiency
- Adapt search approach based on thoroughness level specified

# Output
- Use absolute file paths in all references
- Report findings as regular messages
- Do not use emojis
- Be thorough and precise`,
			promptMode: "replace",
			isDefault: true,
		},
	],
]);
