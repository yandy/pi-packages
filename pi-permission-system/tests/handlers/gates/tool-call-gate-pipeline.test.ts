import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessPath } from "../../../src/access-intent/access-path";
import { ToolCallGatePipeline } from "../../../src/handlers/gates/tool-call-gate-pipeline";

import {
  makeGateInputs,
  makeGateRunner,
  makeResolver,
  makeTcc,
} from "../../helpers/gate-fixtures";
import { makeCheckResult } from "../../helpers/handler-fixtures";

// ── BashProgram.parse mock ─────────────────────────────────────────────────

const { mockBashProgramParse } = vi.hoisted(() => ({
  mockBashProgramParse: vi.fn(),
}));

vi.mock("../../../src/access-intent/bash/program", () => ({
  BashProgram: { parse: mockBashProgramParse },
}));

function makeMockBashProgram() {
  return {
    commands: vi.fn<() => []>(() => []),
    pathRuleCandidates: vi.fn<() => []>(() => []),
    externalPaths: vi.fn<() => AccessPath[]>(() => []),
  };
}

// ── ToolCallGatePipeline ───────────────────────────────────────────────────

describe("ToolCallGatePipeline", () => {
  beforeEach(() => {
    mockBashProgramParse.mockReset();
    mockBashProgramParse.mockResolvedValue(makeMockBashProgram());
  });

  // ── non-bash tools ───────────────────────────────────────────────────────

  describe("evaluate — non-bash tool", () => {
    it("returns allow when all gates pass", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      const result = await pipeline.evaluate(
        makeTcc({ toolName: "read", input: {} }),
        runner,
      );

      expect(result).toEqual({ action: "allow" });
    });

    it("returns block when the tool gate denies", async () => {
      const resolver = makeResolver(
        makeCheckResult({ state: "deny", matchedPattern: "*" }),
      );
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      const result = await pipeline.evaluate(
        makeTcc({ toolName: "read", input: {} }),
        runner,
      );

      expect(result).toMatchObject({ action: "block" });
    });

    it("short-circuits after the first blocking gate without evaluating later ones", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const runSpy = vi
        .spyOn(runner, "run")
        .mockResolvedValue({ action: "block", reason: "first gate blocked" });

      const pipeline = new ToolCallGatePipeline(resolver, inputs);
      const result = await pipeline.evaluate(
        makeTcc({ toolName: "read", input: {} }),
        runner,
      );

      expect(result).toEqual({ action: "block", reason: "first gate blocked" });
      // Pipeline looped to the first gate, got block, and stopped — not all 6 gates.
      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it("calls getToolPreviewLimits() during evaluate", async () => {
      const getToolPreviewLimits = vi.fn(() => ({
        toolInputPreviewMaxLength: 500,
        toolTextSummaryMaxLength: 100,
        toolInputLogPreviewMaxLength: 200,
      }));
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs({ getToolPreviewLimits });
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(makeTcc({ toolName: "read", input: {} }), runner);

      expect(getToolPreviewLimits).toHaveBeenCalled();
    });

    it("calls getInfrastructureReadDirs() during evaluate", async () => {
      const getInfrastructureReadDirs = vi.fn<() => string[]>(() => []);
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs({ getInfrastructureReadDirs });
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(makeTcc({ toolName: "read", input: {} }), runner);

      expect(getInfrastructureReadDirs).toHaveBeenCalled();
    });

    it("calls getActiveSkillEntries() during evaluate", async () => {
      const getActiveSkillEntries = vi.fn<() => []>(() => []);
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs({ getActiveSkillEntries });
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(makeTcc({ toolName: "read", input: {} }), runner);

      expect(getActiveSkillEntries).toHaveBeenCalled();
    });

    it("does not call BashProgram.parse for non-bash tools", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(makeTcc({ toolName: "read", input: {} }), runner);

      expect(mockBashProgramParse).not.toHaveBeenCalled();
    });
  });

  // ── bash tool ────────────────────────────────────────────────────────────

  describe("evaluate — bash tool", () => {
    it("returns allow when the bash command is permitted", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      const result = await pipeline.evaluate(
        makeTcc({ toolName: "bash", input: { command: "echo hello" } }),
        runner,
      );

      expect(result).toEqual({ action: "allow" });
    });

    it("parses BashProgram exactly once per evaluate for bash tools with a command", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(
        makeTcc({ toolName: "bash", input: { command: "echo hello" } }),
        runner,
      );

      expect(mockBashProgramParse).toHaveBeenCalledTimes(1);
      expect(mockBashProgramParse).toHaveBeenCalledWith(
        "echo hello",
        "/test/project",
      );
    });

    it("does not parse BashProgram when the bash command is empty", async () => {
      const resolver = makeResolver(makeCheckResult());
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      await pipeline.evaluate(
        makeTcc({ toolName: "bash", input: { command: "" } }),
        runner,
      );

      expect(mockBashProgramParse).not.toHaveBeenCalled();
    });
  });

  // ── customExtractors threading (#352) ────────────────────────────────────

  describe("evaluate — customExtractors threading (#352)", () => {
    // Deny only the cross-cutting `path` surface; allow everything else, so a
    // block can only come from the path gate seeing the extracted path.
    function pathDenyingResolver() {
      const resolver = makeResolver();
      resolver.resolve.mockImplementation((intent) =>
        intent.surface === "path"
          ? makeCheckResult({ state: "deny", matchedPattern: "*" })
          : makeCheckResult(),
      );
      return resolver;
    }

    const extractors = {
      get: (name: string) =>
        name === "ffgrep"
          ? (input: Record<string, unknown>) =>
              typeof input.target === "string" ? input.target : undefined
          : undefined,
    };

    it("forwards extractors so a custom-shaped tool is path-gated", async () => {
      const resolver = pathDenyingResolver();
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(
        resolver,
        inputs,
        undefined,
        extractors,
      );

      const result = await pipeline.evaluate(
        makeTcc({
          toolName: "ffgrep",
          input: { target: "/test/project/secret.env" },
        }),
        runner,
      );

      expect(result).toMatchObject({ action: "block" });
    });

    it("without extractors the custom-shaped tool is not path-gated", async () => {
      const resolver = pathDenyingResolver();
      const inputs = makeGateInputs();
      const { runner } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      const result = await pipeline.evaluate(
        makeTcc({
          toolName: "ffgrep",
          input: { target: "/test/project/secret.env" },
        }),
        runner,
      );

      expect(result).toEqual({ action: "allow" });
    });
  });
});
