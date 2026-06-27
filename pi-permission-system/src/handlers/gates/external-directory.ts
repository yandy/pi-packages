import { AccessPath } from "../../access-intent/access-path";
import {
  getToolInputPath,
  isPathOutsideWorkingDirectory,
  isPiInfrastructureRead,
  normalizePathForComparison,
} from "../../path-utils";
import type { ScopedPermissionResolver } from "../../permission-resolver";
import { SessionApproval } from "../../session-approval";
import { deriveApprovalPattern } from "../../session-rules";
import type { ToolAccessExtractorLookup } from "../../tool-access-extractor-registry";
import type { GateResult } from "./descriptor";
import { formatExternalDirectoryAskPrompt } from "./external-directory-messages";
import { resolveExternalDirectoryPolicy } from "./external-directory-policy";
import type { ToolCallContext } from "./types";

/**
 * Build a pure descriptor for the external-directory permission gate.
 *
 * Returns `null` when the gate does not apply (no CWD, tool is not
 * path-bearing, or path is inside the working directory).
 * Returns a `GateBypass` for Pi infrastructure reads.
 * Returns a `GateDescriptor` for external paths needing a permission check.
 */
export function describeExternalDirectoryGate(
  tcc: ToolCallContext,
  infraDirs: string[],
  resolver: ScopedPermissionResolver,
  extractors?: ToolAccessExtractorLookup,
): GateResult {
  const externalDirectoryPath = getToolInputPath(
    tcc.toolName,
    tcc.input,
    extractors,
  );
  if (!externalDirectoryPath) return null;

  if (!isPathOutsideWorkingDirectory(externalDirectoryPath, tcc.cwd)) {
    return null;
  }

  // The boundary decision (above) and the infrastructure-read containment
  // check (below) use the canonical, symlink-resolved path; pattern matching
  // uses the typed and resolved aliases (#418).
  const accessPath = AccessPath.forPath(externalDirectoryPath, {
    cwd: tcc.cwd,
  });
  const canonicalExtPath = accessPath.boundaryValue();

  // ── Pi infrastructure read bypass ──────────────────────────────────────
  if (
    isPiInfrastructureRead(tcc.toolName, canonicalExtPath, infraDirs, tcc.cwd)
  ) {
    return {
      action: "allow",
      log: {
        event: "permission_request.infrastructure_auto_allowed",
        details: {
          source: "tool_call",
          toolCallId: tcc.toolCallId,
          toolName: tcc.toolName,
          agentName: tcc.agentName,
          path: externalDirectoryPath,
        },
      },
      decision: {
        surface: tcc.toolName,
        value: externalDirectoryPath,
        result: "allow",
        resolution: "infrastructure_auto_allowed",
        origin: null,
        agentName: tcc.agentName ?? null,
        matchedPattern: null,
      },
    };
  }

  // ── Build descriptor for permission check ───────────────────────────────
  const extDirMessage = formatExternalDirectoryAskPrompt(
    tcc.toolName,
    externalDirectoryPath,
    tcc.cwd,
    tcc.agentName ?? undefined,
  );

  // The runner consumes this preCheck and skips its own resolve.
  const preCheck = resolveExternalDirectoryPolicy(
    accessPath,
    resolver,
    tcc.agentName ?? undefined,
  );
  const pattern = deriveApprovalPattern(
    normalizePathForComparison(externalDirectoryPath, tcc.cwd),
  );

  return {
    surface: "external_directory",
    input: {},
    preCheck,
    denialContext: {
      kind: "external_directory",
      toolName: tcc.toolName,
      pathValue: externalDirectoryPath,
      cwd: tcc.cwd,
      agentName: tcc.agentName ?? undefined,
    },
    sessionApproval: SessionApproval.single("external_directory", pattern),
    promptDetails: {
      source: "tool_call",
      agentName: tcc.agentName,
      message: extDirMessage,
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      path: externalDirectoryPath,
    },
    logContext: {
      source: "tool_call",
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      agentName: tcc.agentName,
      path: externalDirectoryPath,
      message: extDirMessage,
    },
    decision: {
      surface: "external_directory",
      value: externalDirectoryPath,
    },
  };
}
