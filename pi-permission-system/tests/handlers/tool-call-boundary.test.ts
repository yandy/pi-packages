/**
 * The fail-closed boundary is the only tool_call handler the SDK sees.
 *
 * The SDK's emitToolCall (@earendil-works/pi-coding-agent dist/core/extensions/
 * runner.js) awaits the registered handler with NO try/catch — unlike
 * emitUserBash directly below it, which catches and continues. So a thrown
 * gate would otherwise yield no block and the command would run ungated with
 * no trace. This boundary must absorb the throw and fail closed.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { GateOutcome } from "../../src/handlers/gates/types";
import { createFailClosedToolCall } from "../../src/handlers/tool-call-boundary";

import { makeReporter } from "../helpers/gate-fixtures";
import { makeCtx, makeToolCallEvent } from "../helpers/handler-fixtures";

function makeAudit() {
  return {
    recordDecision: vi.fn<(action: "allow" | "block") => void>(),
    recordError: vi.fn<() => void>(),
  };
}

function makeTracer() {
  return {
    debug: vi.fn<(event: string, details?: Record<string, unknown>) => void>(),
  };
}

function gateReturning(outcome: GateOutcome) {
  return vi
    .fn<(event: unknown, ctx: ExtensionContext) => Promise<GateOutcome>>()
    .mockResolvedValue(outcome);
}

describe("createFailClosedToolCall", () => {
  it("translates an allow outcome to the empty SDK shape", async () => {
    const audit = makeAudit();
    const reporter = makeReporter();
    const boundary = createFailClosedToolCall(
      gateReturning({ action: "allow" }),
      reporter,
      audit,
      makeTracer(),
    );

    const result = await boundary(makeToolCallEvent("read"), makeCtx());

    expect(result).toEqual({});
    expect(audit.recordDecision).toHaveBeenCalledWith("allow");
    expect(audit.recordError).not.toHaveBeenCalled();
    expect(reporter.writeReviewLog).not.toHaveBeenCalled();
  });

  it("translates a block outcome to the SDK block shape with the reason", async () => {
    const audit = makeAudit();
    const reporter = makeReporter();
    const boundary = createFailClosedToolCall(
      gateReturning({ action: "block", reason: "denied by policy" }),
      reporter,
      audit,
      makeTracer(),
    );

    const result = await boundary(makeToolCallEvent("read"), makeCtx());

    expect(result).toEqual({ block: true, reason: "denied by policy" });
    expect(audit.recordDecision).toHaveBeenCalledWith("block");
  });

  it("writes a per-call decision trace with the tool name and action", async () => {
    const tracer = makeTracer();
    const boundary = createFailClosedToolCall(
      gateReturning({ action: "allow" }),
      makeReporter(),
      makeAudit(),
      tracer,
    );

    await boundary(makeToolCallEvent("bash"), makeCtx());

    expect(tracer.debug).toHaveBeenCalledWith(
      "permission.decision",
      expect.objectContaining({ toolName: "bash", action: "allow" }),
    );
  });

  it("blocks fail-closed when the gate throws, recording an error and a review-log entry", async () => {
    const audit = makeAudit();
    const reporter = makeReporter();
    const gate = vi
      .fn<(event: unknown, ctx: ExtensionContext) => Promise<GateOutcome>>()
      .mockRejectedValue(new Error("parser init failed"));
    const boundary = createFailClosedToolCall(
      gate,
      reporter,
      audit,
      makeTracer(),
    );

    const event = makeToolCallEvent("bash", {
      input: { command: "cd /repo && git push" },
    });
    const result = await boundary(event, makeCtx());

    expect((result as { block?: true }).block).toBe(true);
    expect(audit.recordError).toHaveBeenCalledTimes(1);
    expect(audit.recordDecision).not.toHaveBeenCalled();
    expect(reporter.writeReviewLog).toHaveBeenCalledWith(
      "permission_request.blocked",
      expect.objectContaining({
        toolName: "bash",
        command: "cd /repo && git push",
        resolution: "gate_error",
        error: "parser init failed",
      }),
    );
  });

  it("does not throw when the event is malformed and the gate throws", async () => {
    const audit = makeAudit();
    const reporter = makeReporter();
    const gate = vi
      .fn<(event: unknown, ctx: ExtensionContext) => Promise<GateOutcome>>()
      .mockRejectedValue("non-error rejection");
    const boundary = createFailClosedToolCall(
      gate,
      reporter,
      audit,
      makeTracer(),
    );

    const result = await boundary(undefined, makeCtx());

    expect((result as { block?: true }).block).toBe(true);
    expect(reporter.writeReviewLog).toHaveBeenCalledWith(
      "permission_request.blocked",
      expect.objectContaining({
        resolution: "gate_error",
        error: "non-error rejection",
      }),
    );
  });
});
