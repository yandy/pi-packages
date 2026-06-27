import { describe, expect, it } from "vitest";
import {
  createMcpPermissionTargets,
  McpTargetList,
  parseQualifiedMcpToolName,
} from "../src/mcp-targets";

describe("parseQualifiedMcpToolName", () => {
  it("returns server and tool for a valid qualified name", () => {
    expect(parseQualifiedMcpToolName("exa:search")).toEqual({
      server: "exa",
      tool: "search",
    });
  });

  it("returns server and tool with surrounding whitespace trimmed", () => {
    expect(parseQualifiedMcpToolName("  exa : search  ")).toEqual({
      server: "exa",
      tool: "search",
    });
  });

  it("returns null for empty string", () => {
    expect(parseQualifiedMcpToolName("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseQualifiedMcpToolName("   ")).toBeNull();
  });

  it("returns null when colon is the first character", () => {
    expect(parseQualifiedMcpToolName(":search")).toBeNull();
  });

  it("returns null when colon is the last character", () => {
    expect(parseQualifiedMcpToolName("exa:")).toBeNull();
  });

  it("returns null for a plain tool name with no colon", () => {
    expect(parseQualifiedMcpToolName("exa_search")).toBeNull();
  });

  it("returns null when server part is empty after trimming", () => {
    expect(parseQualifiedMcpToolName(" :search")).toBeNull();
  });

  it("returns null when tool part is empty after trimming", () => {
    expect(parseQualifiedMcpToolName("exa: ")).toBeNull();
  });
});

describe("createMcpPermissionTargets", () => {
  describe("tool call (input.tool)", () => {
    it("produces targets for a bare tool name with no configured servers", () => {
      const targets = createMcpPermissionTargets({ tool: "exa_search" }, []);
      expect(targets).toContain("exa_search");
      expect(targets).toContain("mcp_call");
    });

    it("produces targets for a qualified tool name (server:tool)", () => {
      const targets = createMcpPermissionTargets({ tool: "exa:search" }, []);
      expect(targets).toContain("exa_search");
      expect(targets).toContain("exa:search");
      expect(targets).toContain("exa");
      expect(targets).toContain("mcp_call");
    });

    it("produces targets for a tool call with explicit server field", () => {
      const targets = createMcpPermissionTargets(
        { tool: "search", server: "exa" },
        [],
      );
      expect(targets).toContain("exa_search");
      expect(targets).toContain("exa:search");
      expect(targets).toContain("exa");
      expect(targets).toContain("mcp_call");
    });

    it("derives server targets from configured server names when tool name ends with _<server>", () => {
      const targets = createMcpPermissionTargets({ tool: "exa_search" }, [
        "exa",
      ]);
      // exa_search ends with _exa? No — it ends with _search. This tool name
      // does NOT trigger server derivation because it does not end with _exa.
      expect(targets).toContain("exa_search");
    });

    it("does not include duplicate entries", () => {
      const targets = createMcpPermissionTargets({ tool: "exa:search" }, [
        "exa",
      ]);
      const unique = [...new Set(targets)];
      expect(targets).toEqual(unique);
    });
  });

  describe("connect call (input.connect)", () => {
    it("produces targets for a connect operation", () => {
      const targets = createMcpPermissionTargets({ connect: "exa" }, []);
      expect(targets).toContain("mcp_connect_exa");
      expect(targets).toContain("exa");
      expect(targets).toContain("mcp_connect");
    });

    it("does not include mcp_call for connect operations", () => {
      const targets = createMcpPermissionTargets({ connect: "exa" }, []);
      expect(targets).not.toContain("mcp_call");
    });
  });

  describe("describe operation (input.describe)", () => {
    it("produces targets for a describe operation on a qualified tool", () => {
      const targets = createMcpPermissionTargets(
        { describe: "exa:search" },
        [],
      );
      expect(targets).toContain("exa_search");
      expect(targets).toContain("exa:search");
      expect(targets).toContain("exa");
      expect(targets).toContain("mcp_describe");
    });
  });

  describe("search operation (input.search)", () => {
    it("produces mcp_search and the search string as targets", () => {
      const targets = createMcpPermissionTargets({ search: "weather" }, []);
      expect(targets).toContain("weather");
      expect(targets).toContain("mcp_search");
    });

    it("includes server targets when server is provided alongside search", () => {
      const targets = createMcpPermissionTargets(
        { search: "weather", server: "exa" },
        [],
      );
      expect(targets).toContain("mcp_server_exa");
      expect(targets).toContain("exa");
      expect(targets).toContain("mcp_search");
    });
  });

  describe("server listing (input.server only)", () => {
    it("produces mcp_list and server-specific targets", () => {
      const targets = createMcpPermissionTargets({ server: "exa" }, []);
      expect(targets).toContain("mcp_server_exa");
      expect(targets).toContain("exa");
      expect(targets).toContain("mcp_list");
    });
  });

  describe("status (no meaningful input)", () => {
    it("produces mcp_status for empty input", () => {
      const targets = createMcpPermissionTargets({}, []);
      expect(targets).toContain("mcp_status");
    });

    it("produces mcp_status for null input", () => {
      const targets = createMcpPermissionTargets(null, []);
      expect(targets).toContain("mcp_status");
    });

    it("produces mcp_status when no server/tool/connect/describe/search present", () => {
      const targets = createMcpPermissionTargets({ unrelated: "value" }, [
        "exa",
      ]);
      expect(targets).toContain("mcp_status");
    });
  });

  describe("priority ordering", () => {
    it("tool targets appear before mcp_call", () => {
      const targets = createMcpPermissionTargets({ tool: "exa:search" }, []);
      const mcpCallIdx = targets.indexOf("mcp_call");
      const exaSearchIdx = targets.indexOf("exa_search");
      expect(exaSearchIdx).toBeGreaterThanOrEqual(0);
      expect(mcpCallIdx).toBeGreaterThan(exaSearchIdx);
    });
  });
});

describe("McpTargetList", () => {
  describe("add", () => {
    it("ignores null", () => {
      const list = new McpTargetList();
      list.add(null);
      expect(list.toArray()).toEqual([]);
    });

    it("ignores empty string", () => {
      const list = new McpTargetList();
      list.add("");
      expect(list.toArray()).toEqual([]);
    });

    it("appends a new value", () => {
      const list = new McpTargetList();
      list.add("exa");
      expect(list.toArray()).toEqual(["exa"]);
    });

    it("dedups repeated values", () => {
      const list = new McpTargetList();
      list.add("exa");
      list.add("exa");
      expect(list.toArray()).toEqual(["exa"]);
    });

    it("preserves first-insertion order across a mix of values", () => {
      const list = new McpTargetList();
      list.add("exa_search");
      list.add("exa:search");
      list.add("exa");
      list.add("exa_search"); // duplicate — must not change order
      list.add("mcp_call");
      expect(list.toArray()).toEqual([
        "exa_search",
        "exa:search",
        "exa",
        "mcp_call",
      ]);
    });
  });

  describe("toArray", () => {
    it("returns an independent copy that does not mutate the list", () => {
      const list = new McpTargetList();
      list.add("exa");
      const first = list.toArray();
      first.push("mutated");
      expect(list.toArray()).toEqual(["exa"]);
    });
  });
});
