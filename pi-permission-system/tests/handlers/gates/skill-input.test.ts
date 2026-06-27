import { describe, expect, it } from "vitest";

import { describeSkillInputGate } from "../../../src/handlers/gates/skill-input";
import { makeCheckResult } from "../../helpers/handler-fixtures";

// ── helpers ────────────────────────────────────────────────────────────────

function makeSkillCheck(state: "allow" | "deny" | "ask") {
  return makeCheckResult({
    state,
    toolName: "skill",
    source: "skill",
    origin: "global",
    matchedPattern: "*",
  });
}

// ── describeSkillInputGate ─────────────────────────────────────────────────

describe("describeSkillInputGate", () => {
  it("sets surface to 'skill'", () => {
    const descriptor = describeSkillInputGate(
      "librarian",
      null,
      makeSkillCheck("allow"),
    );
    expect(descriptor.surface).toBe("skill");
  });

  it("sets input.name to the skill name", () => {
    const descriptor = describeSkillInputGate(
      "librarian",
      null,
      makeSkillCheck("allow"),
    );
    expect(descriptor.input).toEqual({ name: "librarian" });
  });

  it("passes preCheck through verbatim", () => {
    const check = makeSkillCheck("deny");
    const descriptor = describeSkillInputGate("librarian", null, check);
    expect(descriptor.preCheck).toBe(check);
  });

  it("sets denialContext with kind skill_input and skill name", () => {
    const descriptor = describeSkillInputGate(
      "librarian",
      null,
      makeSkillCheck("allow"),
    );
    expect(descriptor.denialContext).toEqual({
      kind: "skill_input",
      skillName: "librarian",
      agentName: undefined,
    });
  });

  it("includes agentName in denialContext when provided", () => {
    const descriptor = describeSkillInputGate(
      "librarian",
      "code-agent",
      makeSkillCheck("allow"),
    );
    expect(descriptor.denialContext).toEqual({
      kind: "skill_input",
      skillName: "librarian",
      agentName: "code-agent",
    });
  });

  it("sets promptDetails source to 'skill_input' with skill name and agent", () => {
    const descriptor = describeSkillInputGate(
      "librarian",
      "code-agent",
      makeSkillCheck("ask"),
    );
    expect(descriptor.promptDetails).toMatchObject({
      source: "skill_input",
      agentName: "code-agent",
      skillName: "librarian",
    });
  });

  it("includes a non-empty message in promptDetails", () => {
    const descriptor = describeSkillInputGate(
      "librarian",
      null,
      makeSkillCheck("ask"),
    );
    expect(typeof descriptor.promptDetails.message).toBe("string");
    expect(descriptor.promptDetails.message.length).toBeGreaterThan(0);
  });

  it("sets logContext source to 'skill_input' with skill name and agent", () => {
    const descriptor = describeSkillInputGate(
      "librarian",
      "code-agent",
      makeSkillCheck("allow"),
    );
    expect(descriptor.logContext).toMatchObject({
      source: "skill_input",
      skillName: "librarian",
      agentName: "code-agent",
    });
  });

  it("sets decision surface to 'skill' and value to the skill name", () => {
    const descriptor = describeSkillInputGate(
      "my-skill",
      null,
      makeSkillCheck("allow"),
    );
    expect(descriptor.decision).toEqual({
      surface: "skill",
      value: "my-skill",
    });
  });

  it("does not set preResolved or sessionApproval", () => {
    const descriptor = describeSkillInputGate(
      "librarian",
      null,
      makeSkillCheck("allow"),
    );
    expect(descriptor.preResolved).toBeUndefined();
    expect(descriptor.sessionApproval).toBeUndefined();
  });
});
