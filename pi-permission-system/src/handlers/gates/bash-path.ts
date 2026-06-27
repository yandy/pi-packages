import type { AccessPath } from "../../access-intent/access-path";
import type { BashProgram } from "../../access-intent/bash/program";
import type { ScopedPermissionResolver } from "../../permission-resolver";
import { SessionApproval } from "../../session-approval";
import { deriveApprovalPattern } from "../../session-rules";
import type { PermissionCheckResult } from "../../types";
import { getNonEmptyString, toRecord } from "../../value-guards";
import { pickMostRestrictive } from "./candidate-check";
import type { GateResult } from "./descriptor";
import { formatPathAskPrompt } from "./path";
import type { ToolCallContext } from "./types";

/**
 * Build a pure descriptor for the cross-cutting path permission gate (bash).
 *
 * Reads path-rule candidates from the injected `BashProgram` (the broader
 * `path`-rule filter, accepting dot-files and relative paths). Each candidate
 * pairs the raw token with cd-aware policy values; the gate evaluates those
 * values against the `path` permission surface and returns the most
 * restrictive result, while prompts, logs, and session approvals use the raw
 * token.
 *
 * Returns `null` when the gate does not apply (tool is not bash, no command,
 * no tokens extracted, or all tokens evaluate to `allow`).
 * Returns a `GateBypass` when all tokens are session-covered.
 * Returns a `GateDescriptor` for the most restrictive token needing a check.
 */
export function describeBashPathGate(
  tcc: ToolCallContext,
  bashProgram: BashProgram | null,
  resolver: ScopedPermissionResolver,
): GateResult {
  if (tcc.toolName !== "bash") return null;

  const command = getNonEmptyString(toRecord(tcc.input).command);
  if (!command) return null;

  if (!bashProgram) return null;

  const candidates = bashProgram.pathRuleCandidates();
  if (candidates.length === 0) return null;
  const tokens = candidates.map(({ token }) => token);

  // Tokens whose resolved state needs a check (deny/ask), paired with the raw
  // token (prompt/decision display) and its `AccessPath` (whose `value()` is
  // the lexical absolute path the approval pattern is derived from).
  const uncovered: Array<{
    token: string;
    path: AccessPath;
    check: PermissionCheckResult;
  }> = [];
  let allSessionCovered = true;

  for (const { token, path } of candidates) {
    const check = resolver.resolve({
      kind: "access-path",
      surface: "path",
      path,
      agentName: tcc.agentName ?? undefined,
    });

    // No explicit path rule matched — only the universal default fired.
    // Treat this token as unrestricted to preserve backward compatibility
    // for configs without a "path" key (#58).
    if (check.matchedPattern === undefined && check.source !== "session") {
      allSessionCovered = false;
      continue;
    }

    if (check.source !== "session") {
      allSessionCovered = false;
    }

    if (check.state === "deny") {
      uncovered.push({ token, path, check });
      break; // Short-circuit on deny.
    }
    if (check.state === "ask") {
      uncovered.push({ token, path, check });
    }
  }

  // All tokens are session-covered — bypass.
  if (allSessionCovered) {
    return {
      action: "allow",
      log: {
        event: "permission_request.session_approved",
        details: {
          source: "tool_call",
          toolCallId: tcc.toolCallId,
          toolName: tcc.toolName,
          agentName: tcc.agentName,
          command,
          tokens,
          resolution: "session_approved",
        },
      },
    };
  }

  // Pick the most restrictive (deny > ask > allow, first-wins) uncovered token.
  const worstCheck = pickMostRestrictive(uncovered.map(({ check }) => check));
  const worstEntry = worstCheck
    ? uncovered.find(({ check }) => check === worstCheck)
    : undefined;
  const worstToken = worstEntry?.token ?? null;

  // All tokens evaluate to allow — no restriction.
  if (!worstCheck || !worstToken || !worstEntry) return null;

  // Derive the pattern from the lexical absolute form (the cd-aware resolved
  // path), so it matches the values a later call produces. For an unknown base
  // (`forLiteral`) `value()` is the raw token.
  const pattern = deriveApprovalPattern(worstEntry.path.value());
  const askMessage = formatPathAskPrompt(
    tcc.toolName,
    worstToken,
    tcc.agentName ?? undefined,
  );

  return {
    surface: "path",
    input: { path: worstToken },
    denialContext: {
      kind: "bash_path",
      command,
      pathValue: worstToken,
      agentName: tcc.agentName ?? undefined,
    },
    sessionApproval: SessionApproval.single("path", pattern),
    promptDetails: {
      source: "tool_call",
      agentName: tcc.agentName,
      message: askMessage,
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      command,
    },
    logContext: {
      source: "tool_call",
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      agentName: tcc.agentName,
      command,
      path: worstToken,
    },
    decision: {
      surface: "path",
      value: worstToken,
    },
    preCheck: worstCheck,
  };
}
