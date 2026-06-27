import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ConfigReader } from "./config-store";
import type { GatePrompter } from "./gate-prompter";
import type { PermissionPromptDecision } from "./permission-dialog";
import type {
  PermissionPrompterApi,
  PromptPermissionDetails,
} from "./permission-prompter";
import { isSubagentExecutionContext } from "./subagent-context";
import type { SubagentSessionRegistry } from "./subagent-registry";
import { canResolveAskPermissionRequest } from "./yolo-mode";

/**
 * Dependencies required by PromptingGateway.
 *
 * All four fields are actively consumed:
 * - `config` + `subagentSessionsDir` + `registry` drive `canConfirm()`.
 * - `prompter` is called by `prompt()`.
 */
export interface PromptingGatewayDeps {
  /** Read current config for the yolo-mode branch of the can-prompt policy. */
  config: ConfigReader;
  /** Static path used to detect a forwarding subagent context. */
  subagentSessionsDir: string;
  /** Process-global registry used to detect a registered child session. */
  registry?: SubagentSessionRegistry;
  /** Resolves the permission decision: direct UI dialog or forwarded to parent. */
  prompter: PermissionPrompterApi;
}

/**
 * The lifecycle slice of the gateway that PermissionSession drives.
 *
 * PermissionSession calls activate/deactivate to keep the gateway's stored
 * context in sync with its own — the same pattern used for ForwardingController.
 */
export interface PromptingGatewayLifecycle {
  activate(ctx: ExtensionContext): void;
  deactivate(): void;
}

/**
 * Context-owning implementation of the GatePrompter role.
 *
 * Owns the stored ExtensionContext and the "can we prompt?" policy
 * (UI / subagent / yolo-mode), replacing the four twin methods
 * that previously lived on PermissionSession.
 *
 * Lifecycle: PermissionSession drives activate/deactivate so the stored
 * context mirrors the session context without independent call-site changes.
 */
export class PromptingGateway
  implements GatePrompter, PromptingGatewayLifecycle
{
  private context: ExtensionContext | null = null;

  constructor(private readonly deps: PromptingGatewayDeps) {}

  /** Store the current extension context. */
  activate(ctx: ExtensionContext): void {
    this.context = ctx;
  }

  /** Clear the stored context. */
  deactivate(): void {
    this.context = null;
  }

  /**
   * Whether an interactive permission prompt can be shown.
   *
   * Returns false when no context is active. Otherwise delegates to
   * canResolveAskPermissionRequest, which checks hasUI, subagent status,
   * and yolo-mode — relocating the policy from the index.ts closure.
   */
  canConfirm(): boolean {
    if (this.context === null) return false;
    return canResolveAskPermissionRequest({
      config: this.deps.config.current(),
      hasUI: this.context.hasUI,
      isSubagent: isSubagentExecutionContext(
        this.context,
        this.deps.subagentSessionsDir,
        this.deps.registry,
      ),
    });
  }

  /**
   * Prompt the user for a permission decision using the stored context.
   *
   * Rejects if no context is active — canConfirm() guards this in normal use.
   * Implements {@link GatePrompter}.
   */
  prompt(details: PromptPermissionDetails): Promise<PermissionPromptDecision> {
    if (this.context === null) {
      return Promise.reject(
        new Error("prompt called before the session was activated"),
      );
    }
    return this.deps.prompter.prompt(this.context, details);
  }
}
