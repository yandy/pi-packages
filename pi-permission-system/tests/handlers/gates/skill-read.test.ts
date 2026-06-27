import { describe, expect, it, vi } from "vitest";
import { describeSkillReadGate } from "../../../src/handlers/gates/skill-read";
import type { ToolCallContext } from "../../../src/handlers/gates/types";
import type { SkillPromptEntry } from "../../../src/skill-prompt-sanitizer";

// ── SDK stubs ──────────────────────────────────────────────────────────────
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...original };
});

// ── helpers ────────────────────────────────────────────────────────────────

function makeSkillEntry(
  overrides: Partial<SkillPromptEntry> = {},
): SkillPromptEntry {
  return {
    name: "librarian",
    description: "Research skills",
    location: "/skills/librarian/SKILL.md",
    state: "ask",
    normalizedLocation: "/skills/librarian/SKILL.md",
    normalizedBaseDir: "/skills/librarian",
    ...overrides,
  };
}

function makeTcc(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    toolName: "read",
    agentName: null,
    input: { path: "/skills/librarian/SKILL.md" },
    toolCallId: "tc-1",
    cwd: "/test/project",
    ...overrides,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("describeSkillReadGate", () => {
  it("returns null when tool is not read", () => {
    const result = describeSkillReadGate(makeTcc({ toolName: "write" }), () => [
      makeSkillEntry(),
    ]);
    expect(result).toBeNull();
  });

  it("returns null when no active skill entries", () => {
    const result = describeSkillReadGate(makeTcc(), () => []);
    expect(result).toBeNull();
  });

  it("returns null when read path does not match any skill", () => {
    const result = describeSkillReadGate(
      makeTcc({ input: { path: "/test/project/src/index.ts" } }),
      () => [makeSkillEntry()],
    );
    expect(result).toBeNull();
  });

  it("returns null when input has no path", () => {
    const result = describeSkillReadGate(makeTcc({ input: {} }), () => [
      makeSkillEntry(),
    ]);
    expect(result).toBeNull();
  });

  it("returns GateDescriptor with preResolved.state matching skill entry state (ask)", () => {
    const result = describeSkillReadGate(makeTcc(), () => [
      makeSkillEntry({ state: "ask" }),
    ]);
    expect(result).not.toBeNull();
    const desc = result!;
    expect(desc.preResolved).toEqual({ state: "ask" });
  });

  it("returns GateDescriptor with preResolved.state matching skill entry state (allow)", () => {
    const result = describeSkillReadGate(makeTcc(), () => [
      makeSkillEntry({ state: "allow" }),
    ]);
    expect(result).not.toBeNull();
    const desc = result!;
    expect(desc.preResolved).toEqual({ state: "allow" });
  });

  it("returns GateDescriptor with preResolved.state matching skill entry state (deny)", () => {
    const result = describeSkillReadGate(makeTcc(), () => [
      makeSkillEntry({ state: "deny" }),
    ]);
    expect(result).not.toBeNull();
    const desc = result!;
    expect(desc.preResolved).toEqual({ state: "deny" });
  });

  it("decision surface is 'skill' and decision value is the skill name", () => {
    const result = describeSkillReadGate(makeTcc(), () => [
      makeSkillEntry({ name: "my-skill" }),
    ])!;
    expect(result.decision.surface).toBe("skill");
    expect(result.decision.value).toBe("my-skill");
  });

  it("denialContext contains the skill name and read path", () => {
    const result = describeSkillReadGate(makeTcc(), () => [
      makeSkillEntry({ name: "librarian" }),
    ])!;
    expect(result.denialContext).toEqual({
      kind: "skill_read",
      skillName: "librarian",
      readPath: "/skills/librarian/SKILL.md",
      agentName: undefined,
    });
  });

  it("promptDetails includes skill_read source and skillName", () => {
    const result = describeSkillReadGate(
      makeTcc({ agentName: "test-agent", toolCallId: "tc-42" }),
      () => [makeSkillEntry({ name: "my-skill" })],
    )!;
    expect(result.promptDetails).toMatchObject({
      source: "skill_read",
      agentName: "test-agent",
      toolCallId: "tc-42",
      toolName: "read",
      skillName: "my-skill",
    });
    expect(result.promptDetails.message).toBeDefined();
  });

  it("logContext includes skill_read source and skillName", () => {
    const result = describeSkillReadGate(
      makeTcc({ agentName: "agent-1" }),
      () => [makeSkillEntry({ name: "librarian" })],
    )!;
    expect(result.logContext).toMatchObject({
      source: "skill_read",
      skillName: "librarian",
      agentName: "agent-1",
    });
  });

  it("surface is 'skill' on the descriptor", () => {
    const result = describeSkillReadGate(makeTcc(), () => [makeSkillEntry()])!;
    expect(result.surface).toBe("skill");
  });
});
