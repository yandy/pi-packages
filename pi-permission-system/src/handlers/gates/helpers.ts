import type { PermissionDecisionEvent, PermissionDecisionResolution } from "../../permission-events";
import type { PermissionCheckResult } from "../../types";

/**
 * Derive the human-readable value for a decision event from a check result.
 * Bash → extracted command; MCP → qualified target;
 * path-bearing tools → file path; others → tool name.
 */
export function deriveDecisionValue(
	toolName: string,
	check: Pick<PermissionCheckResult, "command" | "target">,
	path?: string,
): string {
	if (toolName === "bash") return check.command ?? toolName;
	if (toolName === "mcp") return check.target ?? toolName;
	if (path) return path;
	return toolName;
}

/**
 * Build a `PermissionDecisionEvent` from the gate's inputs.
 *
 * Centralises the `origin / agentName / matchedPattern ?? null` normalization
 * that is otherwise duplicated across the session-hit path and the gate-result
 * path in `runGateCheck`.
 */
export function buildDecisionEvent(
	decision: { surface: string; value: string },
	check: Pick<PermissionCheckResult, "origin" | "matchedPattern">,
	agentName: string | null,
	result: "allow" | "deny",
	resolution: PermissionDecisionResolution,
): PermissionDecisionEvent {
	return {
		surface: decision.surface,
		value: decision.value,
		result,
		resolution,
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- ?? null normalises undefined to null for the log record
		origin: check.origin ?? null,
		agentName: agentName ?? null,
		matchedPattern: check.matchedPattern ?? null,
	};
}

/**
 * Map the gate outcome back to a PermissionDecisionResolution.
 *
 * @param state     - The permission state passed to the gate.
 * @param action    - The gate's resulting action ("allow" | "block").
 * @param hasSession - True when the gate result carries a sessionApproval
 *                    (indicates the user chose "for this session").
 * @param canConfirm - Whether an interactive prompt was available.
 */
export function deriveResolution(
	state: "allow" | "deny" | "ask",
	action: "allow" | "block",
	hasSession: boolean,
	canConfirm: boolean,
	autoApproved = false,
): PermissionDecisionResolution {
	if (state === "allow") return "policy_allow";
	if (state === "deny") return "policy_deny";
	// state === "ask"
	if (action === "allow") {
		if (autoApproved) return "auto_approved";
		return hasSession ? "user_approved_for_session" : "user_approved";
	}
	return canConfirm ? "user_denied" : "confirmation_unavailable";
}
