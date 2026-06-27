import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { DecisionSummaryWriter } from "../decision-audit";
import type { PermissionResolver } from "../permission-resolver";
import type { PermissionSession } from "../permission-session";
import type { ServiceLifecycle } from "../service-lifecycle";
import type { SessionLogger } from "../session-logger";
import { PERMISSION_SYSTEM_STATUS_KEY } from "../status";

/** Minimal subset of SessionStartEvent used by this handler. */
interface SessionStartPayload {
  reason: string;
}

/** Minimal subset of ResourcesDiscoverEvent used by this handler. */
interface ResourcesDiscoverPayload {
  reason: string;
}

/**
 * Handles session lifecycle events: start, reload, and shutdown.
 *
 * Constructor deps:
 * - `session` — encapsulates all mutable session state and lifecycle operations
 * - `resolver` — owns permission-query surface: `getConfigIssues`
 * - `serviceLifecycle` — owns the process-global service publication;
 *   `activate` publishes (skipped for registered subagent children) and emits
 *   the ready event; `teardown` unsubscribes all session listeners and unpublishes
 * - `logger` — injected directly; replaces the former `session.logger` reach-through
 * - `audit` — per-session decision counters; its summary is written on shutdown
 */
export class SessionLifecycleHandler {
  constructor(
    private readonly session: PermissionSession,
    private readonly resolver: PermissionResolver,
    private readonly serviceLifecycle: ServiceLifecycle,
    private readonly logger: SessionLogger,
    private readonly audit: DecisionSummaryWriter,
  ) {}

  handleSessionStart(
    event: SessionStartPayload,
    ctx: ExtensionContext,
  ): Promise<void> {
    this.session.refreshConfig(ctx);
    this.session.resetForNewSession(ctx);
    this.session.logResolvedConfigPaths();

    const agentName = this.session.resolveAgentName(ctx);
    const policyIssues = this.resolver.getConfigIssues(agentName ?? undefined);
    for (const issue of policyIssues) {
      this.logger.warn(issue);
    }

    if (event.reason === "reload") {
      this.logger.debug("lifecycle.reload", {
        triggeredBy: "session_start",
        reason: event.reason,
        cwd: ctx.cwd,
      });
    }

    // Publish the process-global service now that a ctx (and therefore the
    // session id) is available, so an in-process subagent child can be
    // identified and excluded. Emitting ready here keeps the
    // service-resolvable-when-ready ordering contract.
    this.serviceLifecycle.activate(ctx);
    return Promise.resolve();
  }

  handleResourcesDiscover(event: ResourcesDiscoverPayload): Promise<void> {
    if (event.reason !== "reload") {
      return Promise.resolve();
    }

    this.session.reload();
    this.logger.debug("lifecycle.reload", {
      triggeredBy: "resources_discover",
      reason: event.reason,
      cwd: this.session.getRuntimeContext()?.cwd ?? null,
    });
    return Promise.resolve();
  }

  handleSessionShutdown(): Promise<void> {
    const ctx = this.session.getRuntimeContext();
    if (ctx) {
      ctx.ui.setStatus(PERMISSION_SYSTEM_STATUS_KEY, undefined);
    }
    this.audit.writeSummary(this.logger);
    this.session.shutdown();
    this.serviceLifecycle.teardown();
    return Promise.resolve();
  }
}
