import { getNonEmptyString, toRecord } from "./value-guards";

/**
 * An ordered accumulator that owns the uniqueness invariant.
 *
 * `add` ignores null/empty values and silently skips duplicates (first-insertion
 * wins). `toArray` returns the ordered result as an independent copy.
 */
export class McpTargetList {
  private readonly targets: string[] = [];

  add(value: string | null): void {
    if (!value) {
      return;
    }
    if (!this.targets.includes(value)) {
      this.targets.push(value);
    }
  }

  toArray(): string[] {
    return [...this.targets];
  }
}

/**
 * Parse a qualified MCP tool name of the form `server:tool`.
 *
 * Returns `{ server, tool }` when the string contains exactly one colon with
 * non-empty text on both sides; otherwise returns `null`.
 */
export function parseQualifiedMcpToolName(
  value: string,
): { server: string; tool: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex <= 0 || colonIndex >= trimmed.length - 1) {
    return null;
  }

  const server = trimmed.slice(0, colonIndex).trim();
  const tool = trimmed.slice(colonIndex + 1).trim();
  if (!server || !tool) {
    return null;
  }

  return { server, tool };
}

function addDerivedMcpServerTargets(
  toolName: string,
  configuredServerNames: readonly string[],
  targets: McpTargetList,
): void {
  const trimmedToolName = toolName.trim();
  if (!trimmedToolName) {
    return;
  }

  for (const serverName of configuredServerNames) {
    const trimmedServerName = serverName.trim();
    if (!trimmedServerName) {
      continue;
    }

    if (!trimmedToolName.endsWith(`_${trimmedServerName}`)) {
      continue;
    }

    if (trimmedToolName.startsWith(`${trimmedServerName}_`)) {
      continue;
    }

    targets.add(`${trimmedServerName}_${trimmedToolName}`);
    targets.add(`${trimmedServerName}:${trimmedToolName}`);
    targets.add(trimmedServerName);
  }
}

function pushMcpToolPermissionTargets(
  rawReference: string,
  serverHint: string | null,
  configuredServerNames: readonly string[],
  targets: McpTargetList,
): void {
  const qualified = parseQualifiedMcpToolName(rawReference);
  const resolvedServer = serverHint ?? qualified?.server ?? null;
  const resolvedTool = qualified?.tool ?? rawReference;

  if (resolvedServer) {
    targets.add(`${resolvedServer}_${resolvedTool}`);
    targets.add(`${resolvedServer}:${resolvedTool}`);
    targets.add(resolvedServer);
  } else {
    addDerivedMcpServerTargets(resolvedTool, configuredServerNames, targets);
  }

  targets.add(resolvedTool);
  targets.add(rawReference);
}

/**
 * Derive the ordered list of MCP permission-lookup candidates from a raw MCP
 * tool invocation input.
 *
 * Candidates are ordered from most-specific to least-specific so that
 * `evaluateFirst()` stops at the first non-default match.
 */
export function createMcpPermissionTargets(
  input: unknown,
  configuredServerNames: readonly string[] = [],
): string[] {
  const record = toRecord(input);
  const tool = getNonEmptyString(record.tool);
  const server = getNonEmptyString(record.server);
  const connect = getNonEmptyString(record.connect);
  const describe = getNonEmptyString(record.describe);
  const search = getNonEmptyString(record.search);

  const targets = new McpTargetList();

  if (tool) {
    pushMcpToolPermissionTargets(tool, server, configuredServerNames, targets);
    targets.add("mcp_call");
    return targets.toArray();
  }

  if (connect) {
    targets.add(`mcp_connect_${connect}`);
    targets.add(connect);
    targets.add("mcp_connect");
    return targets.toArray();
  }

  if (describe) {
    pushMcpToolPermissionTargets(
      describe,
      server,
      configuredServerNames,
      targets,
    );
    targets.add("mcp_describe");
    return targets.toArray();
  }

  if (search) {
    if (server) {
      targets.add(`mcp_server_${server}`);
      targets.add(server);
    }

    targets.add(search);
    targets.add("mcp_search");
    return targets.toArray();
  }

  if (server) {
    targets.add(`mcp_server_${server}`);
    targets.add(server);
    targets.add("mcp_list");
    return targets.toArray();
  }

  targets.add("mcp_status");
  return targets.toArray();
}
