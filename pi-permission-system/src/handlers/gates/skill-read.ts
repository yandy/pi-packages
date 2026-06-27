import { normalizePathForComparison } from "../../path-utils";
import { formatSkillPathAskPrompt } from "../../permission-prompts";
import type { SkillPromptEntry } from "../../skill-prompt-sanitizer";
import { findSkillPathMatch } from "../../skill-prompt-sanitizer";
import { toRecord } from "../../value-guards";
import type { GateDescriptor } from "./descriptor";
import type { ToolCallContext } from "./types";

/**
 * Build a pure descriptor for the skill-read permission gate.
 *
 * Returns `null` when the gate does not apply (tool is not `read`, no active
 * skill entries, or the read path does not match any skill).
 * Returns a GateDescriptor with preResolved state from the matched skill entry.
 */
export function describeSkillReadGate(
  tcc: ToolCallContext,
  getActiveSkillEntries: () => SkillPromptEntry[],
): GateDescriptor | null {
  const activeSkillEntries = getActiveSkillEntries();

  if (tcc.toolName !== "read" || activeSkillEntries.length === 0) {
    return null;
  }

  const inputRecord = toRecord(tcc.input);
  const path = typeof inputRecord.path === "string" ? inputRecord.path : "";
  if (!path) {
    return null;
  }

  const normalizedReadPath = normalizePathForComparison(path, tcc.cwd);
  const matchedSkill = findSkillPathMatch(
    normalizedReadPath,
    activeSkillEntries,
  );

  if (!matchedSkill) {
    return null;
  }

  const skillReadMessage = formatSkillPathAskPrompt(
    matchedSkill,
    path,
    tcc.agentName ?? undefined,
  );

  return {
    surface: "skill",
    input: { name: matchedSkill.name },
    denialContext: {
      kind: "skill_read",
      skillName: matchedSkill.name,
      readPath: path,
      agentName: tcc.agentName ?? undefined,
    },
    promptDetails: {
      source: "skill_read",
      agentName: tcc.agentName,
      message: skillReadMessage,
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      skillName: matchedSkill.name,
      path,
    },
    logContext: {
      source: "skill_read",
      skillName: matchedSkill.name,
      agentName: tcc.agentName,
      path,
      message: skillReadMessage,
    },
    decision: {
      surface: "skill",
      value: matchedSkill.name,
    },
    preResolved: {
      state: matchedSkill.state,
    },
  };
}
