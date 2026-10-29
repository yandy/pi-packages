/**
 * prompts.ts — System prompt assembly for agents.
 *
 * Two shapes, one per `prompt_mode`:
 *
 * - "append": the harness renders the base system prompt for the child's OWN
 *   tool set (tool list, guidelines, skills, AGENTS.md, SYSTEM.md, date/cwd)
 *   and this module only contributes a section appended to it.
 * - "replace": this module owns the whole prompt. The caller's rendered prompt
 *   is deliberately NOT reused — it carries the caller's tool list and
 *   guidelines, its cwd/date, and project context the child suppresses.
 *
 * Both shapes emit an `<active_agent name="..."/>` tag so downstream extensions
 * can resolve per-agent policy by parsing the child's system prompt.
 */

import type { EnvInfo } from "../session/env";
import type { AgentPromptConfig } from "../types";

/**
 * Fallback prompt for a replace agent whose body is empty — nothing else uses
 * it. It asserts no role and no capability: in replace mode the body IS the
 * spec, and a generic persona prepended to it would mislabel read-only or
 * non-coding agents (and is the only capability text the model would see, since
 * replace mode renders no tool list). Only the `tools` allowlist grants abilities.
 */
const emptyPrompt = `# Role
Your role is defined by the instructions below.
Your available tools are the ones exposed to you in this session; respect any restrictions stated below.
Do what has been asked; nothing more, nothing less.`;

/** Environment header shared by both modes. cwd and date are rendered by the harness. */
function environmentBlock(env: EnvInfo): string {
	return `# Environment
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;
}

/**
 * Build the complete system prompt for a "replace" agent:
 * active_agent tag → env header → the agent body verbatim.
 *
 * Only an empty body gets `emptyPrompt` in front of it; a non-empty body is the
 * agent's whole spec, so nothing generic is prepended. No `<sub_agent_context>`
 * bridge and no `<agent_instructions>` wrapper either: this is not an addendum
 * to someone else's prompt.
 */
export function buildReplacePrompt(config: AgentPromptConfig, env: EnvInfo): string {
	const identity = config.systemPrompt.trim() ? "" : `${emptyPrompt}\n\n`;
	return `${identity}<active_agent name="${config.name}"/>\n\n${environmentBlock(env)}\n\n${config.systemPrompt}`;
}

/**
 * Build the section appended to the harness-rendered base prompt for an
 * "append" agent: sub-agent bridge → active_agent tag → env header → the agent
 * body wrapped in `<agent_instructions>` (omitted when the body is empty).
 *
 * Starts with a blank line so it can be concatenated after the base prompt.
 */
export function buildAppendSection(config: AgentPromptConfig, env: EnvInfo): string {
	const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;

	const customSection = config.systemPrompt.trim()
		? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
		: "";

	return `\n\n${bridge}\n\n<active_agent name="${config.name}"/>\n\n${environmentBlock(env)}${customSection}`;
}
