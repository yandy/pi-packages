import type { DenialContext } from "../../denial-messages";
import type { PermissionDecisionEvent } from "../../permission-events";
import type { PromptPermissionDetails } from "../../permission-prompter";
import type { SessionApproval } from "../../session-approval";
import type { PermissionCheckResult, PermissionState } from "../../types";

// ── Descriptor types ───────────────────────────────────────────────────────

/**
 * Pure output of a gate function — describes what to check and how to present it.
 *
 * The gate runner (`runGateCheck`) uses this descriptor to execute the
 * mechanical check→log→emit→approve cycle without the gate needing to know
 * about logging, event emission, or session-rule recording.
 */
export interface GateDescriptor {
  /** Permission surface to check (e.g. "bash", "external_directory", "skill"). */
  surface: string;
  /** Input passed to checkPermission. */
  input: unknown;
  /** Structured denial context — the runner formats messages from this. */
  denialContext: DenialContext;
  /**
   * Session-approval suggestion for the "for this session" option.
   * Wraps either a single pattern or multiple patterns behind a unified
   * interface — the runner never needs to know which case applies.
   */
  sessionApproval?: SessionApproval;
  /** Details passed to the interactive permission prompt (requestId is added by the runner). */
  promptDetails: Omit<PromptPermissionDetails, "requestId">;
  /** Extra context fields written to the review log alongside gate outcomes. */
  logContext: Record<string, unknown>;
  /** Surface and value for the decision event (may differ from the check surface). */
  decision: {
    surface: string;
    value: string;
  };
  /**
   * When set, the gate has already resolved the permission state
   * (e.g. from a skill entry match). The runner uses this directly
   * instead of calling checkPermission.
   */
  preResolved?: {
    state: PermissionState;
  };
  /**
   * When set, the runner uses this pre-computed check result directly
   * instead of calling checkPermission. Used when the orchestrator has
   * already performed the check (e.g. to build messages from the result).
   */
  preCheck?: PermissionCheckResult;
}

/**
 * Early allow result — gate has determined the action without needing the runner.
 *
 * Used for cases like Pi infrastructure read bypass where the gate short-circuits
 * with a deterministic allow before reaching the permission check.
 */
export interface GateBypass {
  action: "allow";
  /** Optional review log entry to emit. */
  log?: { event: string; details: Record<string, unknown> };
  /** Optional decision event to emit. */
  decision?: PermissionDecisionEvent;
}

/** Union of possible gate function return values. */
export type GateResult = GateDescriptor | GateBypass | null;

// ── Type guard helpers ─────────────────────────────────────────────────────

/** Check whether a GateResult is a GateBypass (early allow). */
export function isGateBypass(result: GateResult): result is GateBypass {
  return result !== null && "action" in result;
}

/** Check whether a GateResult is a GateDescriptor (needs runner). */
export function isGateDescriptor(result: GateResult): result is GateDescriptor {
  return result !== null && !("action" in result);
}
