import { BashProgram } from "../../access-intent/bash/program";
import type { ScopedPermissionResolver } from "../../permission-resolver";
import type { SkillPromptEntry } from "../../skill-prompt-sanitizer";
import type { ToolAccessExtractorLookup } from "../../tool-access-extractor-registry";
import type { ToolInputFormatterLookup } from "../../tool-input-formatter-registry";
import {
  ToolPreviewFormatter,
  type ToolPreviewFormatterOptions,
} from "../../tool-preview-formatter";
import { getNonEmptyString, toRecord } from "../../value-guards";
import { resolveBashCommandCheck } from "./bash-command";
import { describeBashExternalDirectoryGate } from "./bash-external-directory";
import { describeBashPathGate } from "./bash-path";
import type { GateResult } from "./descriptor";
import { describeExternalDirectoryGate } from "./external-directory";
import { describePathGate } from "./path";
import type { GateRunner } from "./runner";
import { describeSkillReadGate } from "./skill-read";
import { describeToolGate } from "./tool";
import type { GateOutcome, ToolCallContext } from "./types";

/**
 * Narrow interface the pipeline needs from its session-side dependency.
 *
 * The three query methods needed to assemble gate inputs.
 * The resolver is injected separately as a constructor parameter.
 *
 * `PermissionSession` satisfies this structurally at the construction call
 * site; no `implements` clause is needed and would create a layer-inversion
 * import from the domain module into the handler layer.
 */
export interface ToolCallGateInputs {
  /** Active skill prompt entries for the skill-read gate. */
  getActiveSkillEntries(): SkillPromptEntry[];
  /** Combined infrastructure read directories (static + config-derived). */
  getInfrastructureReadDirs(): string[];
  /** Resolved tool-preview formatter options from the current config. */
  getToolPreviewLimits(): ToolPreviewFormatterOptions;
}

/**
 * Owns the ordered tool-call gate-producer assembly and the run loop.
 *
 * Constructed once in the composition root and injected into
 * `PermissionGateHandler`. `evaluate(tcc, runner)` encapsulates:
 * - bash-command extraction and single `BashProgram.parse` (#308)
 * - `ToolPreviewFormatter` construction from `getToolPreviewLimits()`
 * - infrastructure-dir list from `getInfrastructureReadDirs()`
 * - all six gate producers in their prescribed order
 * - the run loop that returns the first block outcome, or allow
 */
export class ToolCallGatePipeline {
  constructor(
    private readonly resolver: ScopedPermissionResolver,
    private readonly inputs: ToolCallGateInputs,
    private readonly customFormatters?: ToolInputFormatterLookup,
    private readonly customExtractors?: ToolAccessExtractorLookup,
  ) {}

  async evaluate(
    tcc: ToolCallContext,
    runner: GateRunner,
  ): Promise<GateOutcome> {
    // Parse the bash command exactly once per evaluate; the three bash gates
    // share this single BashProgram instead of each re-parsing (#308).
    const command = getNonEmptyString(toRecord(tcc.input).command);
    const bashProgram =
      tcc.toolName === "bash" && command
        ? await BashProgram.parse(command, tcc.cwd)
        : null;

    const formatter = new ToolPreviewFormatter(
      this.inputs.getToolPreviewLimits(),
      this.customFormatters,
    );

    const infraDirs = this.inputs.getInfrastructureReadDirs();

    const gateProducers: Array<() => GateResult | Promise<GateResult>> = [
      () =>
        describeSkillReadGate(tcc, () => this.inputs.getActiveSkillEntries()),
      () => describePathGate(tcc, this.resolver, this.customExtractors),
      () =>
        describeExternalDirectoryGate(
          tcc,
          infraDirs,
          this.resolver,
          this.customExtractors,
        ),
      () => describeBashExternalDirectoryGate(tcc, bashProgram, this.resolver),
      () => describeBashPathGate(tcc, bashProgram, this.resolver),
      () => {
        // Bash commands may chain several sub-commands (`a && b`, `a | b`, …);
        // evaluate each unit from the shared parse on the bash surface and
        // select the most restrictive, rather than matching the whole program
        // string (#301). Other tools evaluate their single input directly.
        const toolCheck =
          tcc.toolName === "bash" && bashProgram
            ? resolveBashCommandCheck(
                command ?? "",
                bashProgram.commands(),
                tcc.agentName ?? undefined,
                this.resolver,
              )
            : this.resolver.resolve({
                kind: "tool",
                surface: tcc.toolName,
                input: tcc.input,
                agentName: tcc.agentName ?? undefined,
              });
        const toolDescriptor = describeToolGate(tcc, toolCheck, formatter);
        toolDescriptor.preCheck = toolCheck;
        return toolDescriptor;
      },
    ];

    for (const produce of gateProducers) {
      const outcome = await runner.run(
        await produce(),
        tcc.agentName,
        tcc.toolCallId,
      );
      if (outcome.action === "block") {
        return outcome;
      }
    }

    return { action: "allow" };
  }
}
