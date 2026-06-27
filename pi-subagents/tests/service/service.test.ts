import { afterEach, describe, expect, it } from "vitest";
import {
  getSubagentsService,
  publishSubagentsService,
  SUBAGENT_EVENTS,
  type SubagentsService,
  unpublishSubagentsService,
} from "../../src/service/service";

const SERVICE_KEY = Symbol.for("@yandy0725/pi-subagents:service");

describe("SubagentsService accessors", () => {
  afterEach(() => {
    // Clean up globalThis after each test
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- required to clean up Symbol-keyed global in tests
    delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
  });

  it("getSubagentsService returns undefined when not published", () => {
    expect(getSubagentsService()).toBeUndefined();
  });

  it("publishSubagentsService stores service on globalThis", () => {
    const mock = { spawn: () => "id" } as unknown as SubagentsService;
    publishSubagentsService(mock);
    expect((globalThis as Record<symbol, unknown>)[SERVICE_KEY]).toBe(mock);
  });

  it("getSubagentsService retrieves the published service", () => {
    const mock = { spawn: () => "id" } as unknown as SubagentsService;
    publishSubagentsService(mock);
    expect(getSubagentsService()).toBe(mock);
  });

  it("unpublishSubagentsService removes the service from globalThis", () => {
    const mock = { spawn: () => "id" } as unknown as SubagentsService;
    publishSubagentsService(mock);
    unpublishSubagentsService();
    expect(getSubagentsService()).toBeUndefined();
  });

  it("getSubagentsService returns undefined after unpublish", () => {
    const mock = { spawn: () => "id" } as unknown as SubagentsService;
    publishSubagentsService(mock);
    unpublishSubagentsService();
    expect((globalThis as Record<symbol, unknown>)[SERVICE_KEY]).toBeUndefined();
  });
});

describe("SUBAGENT_EVENTS", () => {
  it("exports expected event channel constants", () => {
    expect(SUBAGENT_EVENTS.STARTED).toBe("subagents:started");
    expect(SUBAGENT_EVENTS.COMPLETED).toBe("subagents:completed");
    expect(SUBAGENT_EVENTS.FAILED).toBe("subagents:failed");
    expect(SUBAGENT_EVENTS.COMPACTED).toBe("subagents:compacted");
    expect(SUBAGENT_EVENTS.CREATED).toBe("subagents:created");
    expect(SUBAGENT_EVENTS.STEERED).toBe("subagents:steered");
  });

  it("does not declare a vacant activity channel", () => {
    expect("ACTIVITY" in SUBAGENT_EVENTS).toBe(false);
  });
});
