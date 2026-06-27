/**
 * prompts.ts — System prompt builder for agents.
 */

import type { EnvInfo } from "../session/env";
import type { AgentPromptConfig } from "../types";

/**
 * Build the system prompt for an agent from its config.
 *
 * Both modes place the shared/stable parent prompt (or `genericBase` when no
 * parent is available) first so the LLM's KV cache can reuse the inherited
 * prefix across all subagent invocations.
 *
 * - "replace" mode: parent/genericBase + active_agent tag + env header +
 *   config.systemPrompt.  No `<sub_agent_context>` bridge and no
 *   `<agent_instructions>` wrapper — the custom prompt has full control and
 *   the final say.
 * - "append" mode: parent/genericBase + sub-agent context bridge +
 *   active_agent tag + env header + config.systemPrompt (wrapped in
 *   `<agent_instructions>` when non-empty).
 * - "append" with empty systemPrompt: pure parent clone.
 *
 * Both modes include an `<active_agent name="${config.name}"/>` tag so
 * downstream extensions (e.g. `@yandy0725/pi-permission-system`) can resolve
 * per-agent policy inside the child session by parsing the system prompt.
 * The tag follows the cacheable parent prefix in both modes.
 *
 * @param parentSystemPrompt  The parent agent's effective system prompt.
 */
export function buildAgentPrompt(
  config: AgentPromptConfig,
  cwd: string,
  env: EnvInfo,
  parentSystemPrompt?: string,
): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>\n\n`;

  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;

  const identity = parentSystemPrompt ?? genericBase;

  if (config.promptMode === "append") {

    const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;

    const customSection = config.systemPrompt.trim()
      ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
      : "";

    // Place shared/stable content first so the LLM's KV cache can reuse the
    // inherited prefix across all subagent invocations. The parent prompt is
    // placed verbatim (no wrapper tag) so it forms an identical byte prefix
    // with the parent session, maximising KV cache hits. The <active_agent>
    // tag and env block vary per call and are placed after the cached prefix.
    return (
      identity +
      "\n\n" +
      bridge +
      "\n\n" +
      activeAgentTag +
      envBlock +
      customSection
    );
  }

  // "replace" mode — parent/genericBase prefix first for KV cache reuse, then
  // the active_agent tag, env block, and the config's full system prompt.
  // Unlike append mode, no <sub_agent_context> bridge or <agent_instructions>
  // wrapper is injected — the custom prompt retains full control.
  return identity + "\n\n" + activeAgentTag + envBlock + "\n\n" + config.systemPrompt;
}

/** Fallback base prompt when parent system prompt is unavailable (both modes). */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;
