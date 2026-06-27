import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionsService } from "../src/service";
import {
  PermissionServiceLifecycle,
  type ServiceLifecycle,
} from "../src/service-lifecycle";
import type { SubagentSessionRegistry } from "../src/subagent-registry";

import { makeCtx } from "./helpers/handler-fixtures";

// ── module stubs ───────────────────────────────────────────────────────────

const mockIsRegisteredSubagentChild = vi.hoisted(() =>
  vi.fn<(ctx: unknown, registry: unknown) => boolean>().mockReturnValue(false),
);
const mockPublishPermissionsService = vi.hoisted(() => vi.fn<() => void>());
const mockUnpublishPermissionsService = vi.hoisted(() => vi.fn<() => void>());
const mockEmitReadyEvent = vi.hoisted(() => vi.fn<() => void>());

vi.mock("../src/subagent-context", () => ({
  isRegisteredSubagentChild: mockIsRegisteredSubagentChild,
}));
vi.mock("../src/service", () => ({
  publishPermissionsService: mockPublishPermissionsService,
  unpublishPermissionsService: mockUnpublishPermissionsService,
}));
vi.mock("../src/permission-events", () => ({
  emitReadyEvent: mockEmitReadyEvent,
}));

// ── helpers ────────────────────────────────────────────────────────────────

function makeService(): PermissionsService {
  return {
    checkPermission: vi.fn(),
    getToolPermission: vi.fn(),
    registerToolInputFormatter: vi.fn(),
    registerToolAccessExtractor: vi.fn(),
  };
}

function makeRegistry(): SubagentSessionRegistry {
  return {
    has: vi.fn().mockReturnValue(false),
  } as unknown as SubagentSessionRegistry;
}

function makeLifecycle(overrides?: { subscriptions?: (() => void)[] }) {
  const service = makeService();
  const registry = makeRegistry();
  const events = { emit: vi.fn(), on: vi.fn() };
  const subscriptions = overrides?.subscriptions ?? [];
  const lifecycle = new PermissionServiceLifecycle(
    service,
    registry,
    events,
    subscriptions,
  );
  return { lifecycle, service, registry, events, subscriptions };
}

beforeEach(() => {
  mockIsRegisteredSubagentChild.mockReset();
  mockIsRegisteredSubagentChild.mockReturnValue(false);
  mockPublishPermissionsService.mockReset();
  mockUnpublishPermissionsService.mockReset();
  mockEmitReadyEvent.mockReset();
});

// ── ServiceLifecycle interface shape ──────────────────────────────────────

it("PermissionServiceLifecycle satisfies ServiceLifecycle", () => {
  const { lifecycle } = makeLifecycle();
  const _: ServiceLifecycle = lifecycle;
  expect(_).toBeDefined();
});

// ── activate ──────────────────────────────────────────────────────────────

describe("activate", () => {
  it("publishes the service for a non-child session", () => {
    const ctx = makeCtx();
    const { lifecycle, service } = makeLifecycle();
    mockIsRegisteredSubagentChild.mockReturnValue(false);
    lifecycle.activate(ctx);
    expect(mockPublishPermissionsService).toHaveBeenCalledWith(service);
  });

  it("skips publishing for a registered child session", () => {
    const ctx = makeCtx();
    const { lifecycle } = makeLifecycle();
    mockIsRegisteredSubagentChild.mockReturnValue(true);
    lifecycle.activate(ctx);
    expect(mockPublishPermissionsService).not.toHaveBeenCalled();
  });

  it("always emits the ready event, even for a child session", () => {
    const ctx = makeCtx();
    const { lifecycle, events } = makeLifecycle();
    mockIsRegisteredSubagentChild.mockReturnValue(true);
    lifecycle.activate(ctx);
    expect(mockEmitReadyEvent).toHaveBeenCalledWith(events);
  });

  it("emits ready after publishing the service", () => {
    const ctx = makeCtx();
    const order: string[] = [];
    mockPublishPermissionsService.mockImplementation(() =>
      order.push("publish"),
    );
    mockEmitReadyEvent.mockImplementation(() => order.push("ready"));
    const { lifecycle } = makeLifecycle();
    lifecycle.activate(ctx);
    expect(order).toEqual(["publish", "ready"]);
  });

  it("passes ctx and registry to isRegisteredSubagentChild", () => {
    const ctx = makeCtx();
    const { lifecycle, registry } = makeLifecycle();
    lifecycle.activate(ctx);
    expect(mockIsRegisteredSubagentChild).toHaveBeenCalledWith(ctx, registry);
  });
});

// ── teardown ──────────────────────────────────────────────────────────────

describe("teardown", () => {
  it("calls each subscription unsubscribe function", () => {
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    const unsub3 = vi.fn();
    const { lifecycle } = makeLifecycle({
      subscriptions: [unsub1, unsub2, unsub3],
    });
    lifecycle.teardown();
    expect(unsub1).toHaveBeenCalledOnce();
    expect(unsub2).toHaveBeenCalledOnce();
    expect(unsub3).toHaveBeenCalledOnce();
  });

  it("unpublishes the service after running subscriptions", () => {
    const order: string[] = [];
    const unsub = vi.fn(() => order.push("unsub"));
    mockUnpublishPermissionsService.mockImplementation(() =>
      order.push("unpublish"),
    );
    const { lifecycle } = makeLifecycle({ subscriptions: [unsub] });
    lifecycle.teardown();
    expect(order).toEqual(["unsub", "unpublish"]);
  });

  it("passes the service to unpublishPermissionsService", () => {
    const { lifecycle, service } = makeLifecycle();
    lifecycle.teardown();
    expect(mockUnpublishPermissionsService).toHaveBeenCalledWith(service);
  });

  it("works with no subscriptions", () => {
    const { lifecycle } = makeLifecycle({ subscriptions: [] });
    expect(() => lifecycle.teardown()).not.toThrow();
    expect(mockUnpublishPermissionsService).toHaveBeenCalledOnce();
  });
});
