import { matchQualifier } from "./denial-messages";
import type { SkillPromptEntry } from "./skill-prompt-sanitizer";
import type { ToolPreviewFormatter } from "./tool-preview-formatter";
import type { PermissionCheckResult } from "./types";
import { getNonEmptyString, toRecord } from "./value-guards";

// NOTE: formatDenyReason, formatUserDeniedReason, and
// formatPermissionHardStopHint have been moved to denial-messages.ts.
// This module retains only pre-check messages and user-facing ask prompts.

export function formatMissingToolNameReason(): string {
  return "Tool call was blocked because no tool name was provided. Use a registered tool name from pi.getAllTools().";
}

export function formatUnknownToolReason(
  toolName: string,
  availableToolNames: readonly string[],
): string {
  const preview = availableToolNames.slice(0, 10);
  const suffix = availableToolNames.length > preview.length ? ", ..." : "";
  const availableList =
    preview.length > 0 ? `${preview.join(", ")}${suffix}` : "none";

  const mcpHint =
    toolName === "mcp"
      ? ""
      : ' If this was intended as an MCP server tool, call the registered \'mcp\' tool when available (for example: {"tool":"server:tool"}).';

  return `Tool '${toolName}' is not registered in this runtime and was blocked before permission checks.${mcpHint} Registered tools: ${availableList}.`;
}

export function formatAskPrompt(
  result: PermissionCheckResult,
  agentName?: string,
  input?: unknown,
  formatter?: ToolPreviewFormatter,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";

  if (result.toolName === "bash") {
    const subCommand = result.command ?? "";
    const qualifier = matchQualifier(
      result.matchedPattern,
      result.commandContext,
    );
    const qualifierInfo = qualifier ? ` ${qualifier}` : "";
    const fullCommand = getNonEmptyString(toRecord(input).command);
    const fullCommandInfo =
      fullCommand && fullCommand !== subCommand
        ? ` (full command: '${fullCommand}')`
        : "";
    return `${subject} requested bash command '${subCommand}'${qualifierInfo}${fullCommandInfo}. Allow this command?`;
  }

  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    const patternInfo = result.matchedPattern
      ? ` (matched '${result.matchedPattern}')`
      : "";
    const mcpPreview = formatter
      ? formatter.formatToolInputForPrompt("mcp", input)
      : "";
    const previewSuffix = mcpPreview ? ` ${mcpPreview}` : "";
    return `${subject} requested MCP target '${result.target}'${patternInfo}${previewSuffix}. Allow this call?`;
  }

  const patternInfo = result.matchedPattern
    ? ` (matched '${result.matchedPattern}')`
    : "";
  const inputPreview = formatter
    ? formatter.formatToolInputForPrompt(result.toolName, input)
    : "";
  const inputSuffix = inputPreview ? ` ${inputPreview}` : "";
  return `${subject} requested tool '${result.toolName}'${patternInfo}${inputSuffix}. Allow this call?`;
}

export function formatSkillAskPrompt(
  skillName: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested skill '${skillName}'. Allow loading this skill?`;
}

export function formatSkillPathAskPrompt(
  skill: SkillPromptEntry,
  readPath: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested access to skill '${skill.name}' via '${readPath}'. Allow this read?`;
}

// formatSkillPathDenyReason has been moved to denial-messages.ts.
