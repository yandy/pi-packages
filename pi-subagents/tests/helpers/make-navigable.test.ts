import { describe, expect, it } from "vitest";
import { makeNavigable } from "./make-navigable";

describe("makeNavigable", () => {
  it("defaults to a completed agent with a ready session", () => {
    const agent = makeNavigable();
    expect(agent.id).toBe("agent-1");
    expect(agent.type).toBe("general-purpose");
    expect(agent.status).toBe("completed");
    expect(agent.toolUses).toBe(2);
    expect(agent.isSessionReady()).toBe(true);
    expect(agent.getToolDefinition("anything")).toBeUndefined();
  });

  it("applies overrides over the defaults", () => {
    const agent = makeNavigable({ id: "x", status: "running", toolUses: 9 });
    expect(agent.id).toBe("x");
    expect(agent.status).toBe("running");
    expect(agent.toolUses).toBe(9);
    // Untouched defaults remain.
    expect(agent.type).toBe("general-purpose");
  });
});
