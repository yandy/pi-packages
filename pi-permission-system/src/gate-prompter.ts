import type { PermissionPromptDecision } from "./permission-dialog";
import type { PromptPermissionDetails } from "./permission-prompter";

/**
 * The prompting role the gate runner needs: a yes/no on whether an
 * interactive confirmation is possible, and the prompt itself. The context
 * is bound by the implementor, not threaded per call.
 */
export interface GatePrompter {
  canConfirm(): boolean;
  prompt(details: PromptPermissionDetails): Promise<PermissionPromptDecision>;
}
