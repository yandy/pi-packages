import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { emitReadyEvent, type PermissionEventBus } from "./permission-events";
import {
  type PermissionsService,
  publishPermissionsService,
  unpublishPermissionsService,
} from "./service";
import { isRegisteredSubagentChild } from "./subagent-context";
import type { SubagentSessionRegistry } from "./subagent-registry";

/** The session-scoped service lifecycle that the lifecycle handler drives. */
export interface ServiceLifecycle {
  activate(ctx: ExtensionContext): void;
  teardown(): void;
}

/**
 * Owns the process-global service publication lifecycle for one extension
 * instance.
 *
 * - `activate` publishes the service (skipped for registered subagent children
 *   so they never clobber the parent's slot — see #302), then emits the ready
 *   event.
 * - `teardown` runs all session-scoped subscription cleanups in order, then
 *   unpublishes the service.
 */
export class PermissionServiceLifecycle implements ServiceLifecycle {
  constructor(
    private readonly service: PermissionsService,
    private readonly registry: SubagentSessionRegistry,
    private readonly events: PermissionEventBus,
    private readonly subscriptions: readonly (() => void)[],
  ) {}

  activate(ctx: ExtensionContext): void {
    if (!isRegisteredSubagentChild(ctx, this.registry)) {
      publishPermissionsService(this.service);
    }
    emitReadyEvent(this.events);
  }

  teardown(): void {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    unpublishPermissionsService(this.service);
  }
}
