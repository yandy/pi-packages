import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAccessIntent } from "../src/access-intent/access-intent";
import { AccessPath } from "../src/access-intent/access-path";
import type { ScopedPermissionManager } from "../src/permission-manager";
import { PermissionResolver } from "../src/permission-resolver";
import type { Ruleset } from "../src/rule";
import { SessionApproval } from "../src/session-approval";
import { SessionRules } from "../src/session-rules";
import type { PermissionCheckResult, PermissionState } from "../src/types";

function makePermissionManager() {
  return {
    configureForCwd: vi.fn<(cwd: string | undefined | null) => void>(),
    check: vi
      .fn<
        (
          intent: ResolvedAccessIntent,
          sessionRules?: Ruleset,
        ) => PermissionCheckResult
      >()
      .mockReturnValue({
        state: "allow",
        toolName: "read",
        source: "tool",
        origin: "builtin",
      }),
    getToolPermission: vi
      .fn<(toolName: string, agentName?: string) => PermissionState>()
      .mockReturnValue("allow"),
    getConfigIssues: vi.fn((): string[] => []),
  };
}

function makeResolver(
  pm?: ScopedPermissionManager,
  sessionRules?: Pick<SessionRules, "getRuleset">,
) {
  const permissionManager = pm ?? makePermissionManager();
  const rules = sessionRules ?? new SessionRules();
  return {
    resolver: new PermissionResolver(permissionManager, rules),
    permissionManager,
  };
}

beforeEach(() => {
  // no module-level vi.fn() stubs to reset
});

describe("PermissionResolver", () => {
  describe("resolve — tool intent", () => {
    it("forwards a tool intent with the empty session ruleset", () => {
      const { resolver, permissionManager } = makeResolver();

      resolver.resolve({
        kind: "tool",
        surface: "bash",
        input: { command: "ls" },
        agentName: "agent-x",
      });

      expect(permissionManager.check).toHaveBeenCalledWith(
        {
          kind: "tool",
          surface: "bash",
          input: { command: "ls" },
          agentName: "agent-x",
        },
        [],
      );
    });

    it("applies a recorded session approval on the next resolve", () => {
      const pm = makePermissionManager();
      const sessionRules = new SessionRules();
      const { resolver } = makeResolver(pm, sessionRules);

      sessionRules.recordSessionApproval(
        SessionApproval.single("bash", "git *"),
      );
      resolver.resolve({
        kind: "tool",
        surface: "bash",
        input: { command: "git status" },
      });

      const passedRules = vi.mocked(pm.check).mock.calls[0][1];
      expect(passedRules).toHaveLength(1);
      expect(passedRules?.[0]).toMatchObject({
        surface: "bash",
        pattern: "git *",
        action: "allow",
      });
    });

    it("returns the manager's check result", () => {
      const pm = makePermissionManager();
      vi.mocked(pm.check).mockReturnValue({
        state: "deny",
        toolName: "bash",
        source: "bash",
        origin: "global",
        matchedPattern: "rm *",
      });
      const { resolver } = makeResolver(pm);

      const result = resolver.resolve({
        kind: "tool",
        surface: "bash",
        input: { command: "rm -rf /" },
      });

      expect(result).toEqual({
        state: "deny",
        toolName: "bash",
        source: "bash",
        origin: "global",
        matchedPattern: "rm *",
      });
    });
  });

  describe("resolve — session ruleset threading", () => {
    it("applies a recorded session approval on the next call", () => {
      const pm = makePermissionManager();
      const sessionRules = new SessionRules();
      const { resolver } = makeResolver(pm, sessionRules);

      sessionRules.recordSessionApproval(
        SessionApproval.single("path", "src/*"),
      );
      resolver.resolve({
        kind: "access-path",
        surface: "path",
        path: AccessPath.forPath("src/a.ts", { cwd: "/proj" }),
      });

      const passedRules = vi.mocked(pm.check).mock.calls[0][1];
      expect(passedRules).toHaveLength(1);
      expect(passedRules?.[0]).toMatchObject({
        surface: "path",
        pattern: "src/*",
        action: "allow",
      });
    });
  });

  describe("resolve — access-path intent", () => {
    it("unwraps the AccessPath via matchValues() into a path-values intent", () => {
      const { resolver, permissionManager } = makeResolver();
      const accessPath = AccessPath.forPath("/tmp/x", { cwd: "/workspace" });

      resolver.resolve({
        kind: "access-path",
        surface: "external_directory",
        path: accessPath,
        agentName: "agent-x",
      });

      expect(permissionManager.check).toHaveBeenCalledWith(
        {
          kind: "path-values",
          surface: "external_directory",
          values: accessPath.matchValues(),
          agentName: "agent-x",
        },
        [],
      );
    });

    it("returns the manager's check result for an access-path intent", () => {
      const pm = makePermissionManager();
      vi.mocked(pm.check).mockReturnValue({
        state: "deny",
        toolName: "external_directory",
        source: "special",
        origin: "global",
        matchedPattern: "/tmp/*",
      });
      const { resolver } = makeResolver(pm);
      const accessPath = AccessPath.forPath("/tmp/x", { cwd: "/workspace" });

      const result = resolver.resolve({
        kind: "access-path",
        surface: "external_directory",
        path: accessPath,
      });

      expect(result.state).toBe("deny");
      expect(result.matchedPattern).toBe("/tmp/*");
    });
  });

  describe("checkPermission (raw, off-interface)", () => {
    it("delegates to manager.check as a tool intent without session rules", () => {
      const { resolver, permissionManager } = makeResolver();

      resolver.checkPermission("bash", { command: "ls" }, "agent-1");

      expect(permissionManager.check).toHaveBeenCalledWith(
        {
          kind: "tool",
          surface: "bash",
          input: { command: "ls" },
          agentName: "agent-1",
        },
        undefined,
      );
    });

    it("passes optional sessionRules as the second arg to check", () => {
      const { resolver, permissionManager } = makeResolver();
      const extraRules: Ruleset = [
        { surface: "bash", pattern: "*", action: "allow", origin: "session" },
      ];

      resolver.checkPermission(
        "bash",
        { command: "ls" },
        undefined,
        extraRules,
      );

      expect(permissionManager.check).toHaveBeenCalledWith(
        {
          kind: "tool",
          surface: "bash",
          input: { command: "ls" },
          agentName: undefined,
        },
        extraRules,
      );
    });
  });

  describe("getToolPermission", () => {
    it("delegates to permissionManager.getToolPermission", () => {
      const pm = makePermissionManager();
      vi.mocked(pm.getToolPermission).mockReturnValue("deny");
      const { resolver } = makeResolver(pm);

      const result = resolver.getToolPermission("write", "my-agent");

      expect(pm.getToolPermission).toHaveBeenCalledWith("write", "my-agent");
      expect(result).toBe("deny");
    });
  });

  describe("getConfigIssues", () => {
    it("delegates to permissionManager.getConfigIssues", () => {
      const pm = makePermissionManager();
      vi.mocked(pm.getConfigIssues).mockReturnValue(["issue-1"]);
      const { resolver } = makeResolver(pm);

      const result = resolver.getConfigIssues("agent-1");

      expect(pm.getConfigIssues).toHaveBeenCalledWith("agent-1");
      expect(result).toEqual(["issue-1"]);
    });
  });
});
