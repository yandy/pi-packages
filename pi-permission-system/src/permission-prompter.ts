import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigReader } from "./config-store";
import type { ApprovalRequester } from "./forwarded-permissions/permission-forwarder";
import type { PermissionPromptDecision } from "./permission-dialog";
import {
  emitUiPromptEvent,
  type PermissionEventBus,
} from "./permission-events";
import { buildDirectUiPrompt } from "./permission-ui-prompt";
import type { ReviewLogger } from "./session-logger";
import { shouldAutoApprovePermissionState } from "./yolo-mode";

export type PermissionReviewSource = "tool_call" | "skill_input" | "skill_read";

/** Details passed when prompting the user for a permission decision. */
export interface PromptPermissionDetails {
  requestId: string;
  source: PermissionReviewSource;
  agentName: string | null;
  message: string;
  toolCallId?: string;
  toolName?: string;
  skillName?: string;
  path?: string;
  command?: string;
  target?: string;
  toolInputPreview?: string;
  /** Override label for the "for this session" dialog option. */
  sessionLabel?: string;
}

/** Mockable contract for permission prompting. */
export interface PermissionPrompterApi {
  prompt(
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision>;
}

/**
 * Dependencies required by PermissionPrompter.
 *
 * Keeps the prompter's external surface narrow: callers provide config
 * access, a review logger, the UI-prompt event bus, and the forwarder
 * that owns the UI/subagent-forwarding branching logic.
 */
export interface PermissionPrompterDeps {
  /** Read current config for yolo-mode check (called at prompt time). */
  config: ConfigReader;
  /** Write structured entries to the permission review log. */
  logger: ReviewLogger;
  /** Event bus used for UI prompt broadcasts. */
  events: PermissionEventBus;
  /** Resolves the permission decision: direct UI dialog or forwarded to parent. */
  forwarder: ApprovalRequester;
}

/**
 * Encapsulates the full permission-prompt flow:
 *   1. Yolo-mode auto-approval check.
 *   2. Review-log "waiting" entry.
 *   3. UI-present vs. subagent-forwarding branching (via confirmPermission).
 *   4. Review-log "approved" / "denied" entry.
 *
 * Injecting a single PermissionPrompter instance means adding a new prompt
 * parameter (e.g. a future sessionLabel variant) only requires changing
 * PromptPermissionDetails and this class — not the full threading chain.
 */
export class PermissionPrompter implements PermissionPrompterApi {
  constructor(private readonly deps: PermissionPrompterDeps) {}

  async prompt(
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    if (shouldAutoApprovePermissionState("ask", this.deps.config.current())) {
      this.writeReviewEntry("permission_request.auto_approved", details);
      return { approved: true, state: "approved", autoApproved: true };
    }

    this.writeReviewEntry("permission_request.waiting", details);

    // Build the event once. When this session has UI it broadcasts directly;
    // when it does not (a forwarding subagent), the display fields ride along
    // to the parent so the parent emits a non-degraded event from the
    // forwarded path instead of here.
    const uiPrompt = buildDirectUiPrompt(details);
    if (ctx.hasUI) {
      emitUiPromptEvent(this.deps.events, uiPrompt);
    }

    const decision = await this.deps.forwarder.requestApproval(
      ctx,
      details.message,
      details.sessionLabel ? { sessionLabel: details.sessionLabel } : undefined,
      {
        source: uiPrompt.source,
        surface: uiPrompt.surface,
        value: uiPrompt.value,
      },
    );

    this.writeReviewEntry(
      decision.approved
        ? "permission_request.approved"
        : "permission_request.denied",
      {
        ...details,
        resolution: decision.state,
        denialReason: decision.denialReason,
      },
    );

    return decision;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private writeReviewEntry(
    event: string,
    details: PromptPermissionDetails & {
      resolution?: string;
      denialReason?: string;
    },
  ): void {
    this.deps.logger.review(event, {
      requestId: details.requestId,
      source: details.source,
      agentName: details.agentName,
      message: details.message,
      toolCallId: details.toolCallId ?? null,
      toolName: details.toolName ?? null,
      skillName: details.skillName ?? null,
      path: details.path ?? null,
      command: details.command ?? null,
      target: details.target ?? null,
      toolInputPreview: details.toolInputPreview ?? null,
      resolution: details.resolution ?? null,
      denialReason: details.denialReason ?? null,
    });
  }
}
