import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { InboxProcessor } from "./forwarded-permissions/permission-forwarder";
import { PERMISSION_FORWARDING_POLL_INTERVAL_MS } from "./permission-forwarding";
import { isSubagentExecutionContext } from "./subagent-context";
import type { SubagentSessionRegistry } from "./subagent-registry";

/**
 * Narrow interface for the forwarding lifecycle used by `PermissionSession`.
 * `ForwardingManager` satisfies it; tests can provide a plain object mock.
 */
export interface ForwardingController {
  start(ctx: ExtensionContext): void;
  stop(): void;
}

/**
 * Encapsulates the forwarded-permission polling lifecycle.
 *
 * Owns the timer, current context, and processing-lock state that previously
 * lived as 3 mutable fields on `ExtensionRuntime`. Call `start(ctx)` on each
 * session event that may activate forwarding; call `stop()` on session
 * shutdown.
 */
export class ForwardingManager {
  private timer: NodeJS.Timeout | null = null;
  private context: ExtensionContext | null = null;
  private processing = false;

  constructor(
    private readonly subagentSessionsDir: string,
    private readonly forwarder: InboxProcessor,
    private readonly registry?: SubagentSessionRegistry,
  ) {}

  /**
   * Start polling if `ctx` has UI and is not a subagent execution context.
   * No-op (timer stays running) if already polling — updates the stored
   * context so the next tick uses the latest session.
   * Stops any existing poll when the context does not qualify for forwarding.
   */
  start(ctx: ExtensionContext): void {
    if (
      !ctx.hasUI ||
      isSubagentExecutionContext(ctx, this.subagentSessionsDir, this.registry)
    ) {
      this.stop();
      return;
    }
    this.context = ctx;
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      if (!this.context || this.processing) {
        return;
      }
      this.processing = true;
      void this.forwarder.processInbox(this.context).finally(() => {
        this.processing = false;
      });
    }, PERMISSION_FORWARDING_POLL_INTERVAL_MS);
  }

  /** Stop polling and clear all internal state. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.context = null;
    this.processing = false;
  }
}
