import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks (hoisted) ─────────────────────────────────────────────────

const { mockGetActiveAgentName, mockGetActiveAgentNameFromSystemPrompt } =
  vi.hoisted(() => ({
    mockGetActiveAgentName: vi.fn<(ctx: ExtensionContext) => string | null>(),
    mockGetActiveAgentNameFromSystemPrompt:
      vi.fn<(systemPrompt?: string) => string | null>(),
  }));

vi.mock("../src/active-agent", () => ({
  getActiveAgentName: mockGetActiveAgentName,
  getActiveAgentNameFromSystemPrompt: mockGetActiveAgentNameFromSystemPrompt,
}));

// ── Test helpers ───────────────────────────────────────────────────────────

import type { DEFAULT_EXTENSION_CONFIG } from "../src/extension-config";
import { SessionApproval } from "../src/session-approval";
import type { SkillPromptEntry } from "../src/skill-prompt-sanitizer";
import { makeCtx } from "./helpers/handler-fixtures";
import {
  makeConfigStore,
  makeFakePermissionManager,
  makeRealSession,
} from "./helpers/session-fixtures";

// Alias so the existing tests read naturally.
const createSession = makeRealSession;
const makePermissionManager = makeFakePermissionManager;

function makeSkillEntry(
  name: string,
  overrides: Partial<SkillPromptEntry> = {},
): SkillPromptEntry {
  return {
    name,
    description: `${name} skill`,
    location: `/${name}/SKILL.md`,
    state: "allow",
    normalizedLocation: `/${name}/SKILL.md`,
    normalizedBaseDir: `/${name}`,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetActiveAgentName.mockReset();
  mockGetActiveAgentNameFromSystemPrompt.mockReset();
  mockGetActiveAgentName.mockReturnValue(null);
  mockGetActiveAgentNameFromSystemPrompt.mockReturnValue(null);
});

describe("PermissionSession", () => {
  describe("activate and deactivate", () => {
    it("stores the context on activate", () => {
      const { session, forwarding } = createSession();
      const ctx = makeCtx();

      session.activate(ctx);

      expect(forwarding.start).toHaveBeenCalledWith(ctx);
    });

    it("clears context on deactivate", () => {
      const { session, forwarding } = createSession();
      session.activate(makeCtx());
      session.deactivate();

      expect(forwarding.stop).toHaveBeenCalled();
    });

    it("forwards activate to the gateway", () => {
      const { session, gateway } = createSession();
      const ctx = makeCtx();

      session.activate(ctx);

      expect(gateway.activate).toHaveBeenCalledWith(ctx);
    });

    it("forwards deactivate to the gateway", () => {
      const { session, gateway } = createSession();
      session.activate(makeCtx());
      session.deactivate();

      expect(gateway.deactivate).toHaveBeenCalled();
    });
  });

  describe("resetForNewSession", () => {
    it("configures the injected PermissionManager for the context cwd", () => {
      const pm = makePermissionManager();
      const { session } = createSession({ permissionManager: pm });
      const ctx = makeCtx({ cwd: "/new/project" });

      session.resetForNewSession(ctx);

      expect(pm.configureForCwd).toHaveBeenCalledWith("/new/project");
    });

    it("clears skill entries", () => {
      const { session } = createSession();
      session.setActiveSkillEntries([makeSkillEntry("test")]);
      expect(session.getActiveSkillEntries()).toHaveLength(1);

      session.resetForNewSession(makeCtx());

      expect(session.getActiveSkillEntries()).toEqual([]);
    });

    it("starts forwarding with the new context", () => {
      const { session, forwarding } = createSession();
      const ctx = makeCtx();

      session.resetForNewSession(ctx);

      expect(forwarding.start).toHaveBeenCalledWith(ctx);
    });

    it("activates the new context", () => {
      const { session } = createSession();
      const ctx = makeCtx();

      session.resetForNewSession(ctx);

      // Verify context is stored by calling resolveAgentName which needs it
      mockGetActiveAgentName.mockReturnValue("test-agent");
      const name = session.resolveAgentName(ctx);
      expect(name).toBe("test-agent");
    });
  });

  describe("shutdown", () => {
    it("clears session rules", () => {
      const { session, sessionRules } = createSession();
      sessionRules.recordSessionApproval(SessionApproval.single("bash", "*"));
      expect(sessionRules.getRuleset()).toHaveLength(1);

      session.shutdown();

      expect(sessionRules.getRuleset()).toEqual([]);
    });

    it("clears skill entries", () => {
      const { session } = createSession();
      session.setActiveSkillEntries([makeSkillEntry("s")]);

      session.shutdown();

      expect(session.getActiveSkillEntries()).toEqual([]);
    });

    it("stops forwarding and deactivates context", () => {
      const { session, forwarding } = createSession();
      session.activate(makeCtx());

      session.shutdown();

      expect(forwarding.stop).toHaveBeenCalled();
    });
  });

  describe("skill entries", () => {
    it("get/set skill entries", () => {
      const { session } = createSession();
      const entries = [makeSkillEntry("a"), makeSkillEntry("b")];
      session.setActiveSkillEntries(entries);
      expect(session.getActiveSkillEntries()).toEqual(entries);
    });
  });

  describe("resolveAgentName", () => {
    it("returns name from session context", () => {
      mockGetActiveAgentName.mockReturnValue("ctx-agent");
      const { session } = createSession();
      const ctx = makeCtx();

      expect(session.resolveAgentName(ctx)).toBe("ctx-agent");
    });

    it("falls back to system prompt", () => {
      mockGetActiveAgentName.mockReturnValue(null);
      mockGetActiveAgentNameFromSystemPrompt.mockReturnValue("prompt-agent");
      const { session } = createSession();
      const ctx = makeCtx();

      expect(session.resolveAgentName(ctx, "system prompt")).toBe(
        "prompt-agent",
      );
    });

    it("falls back to last known name", () => {
      const { session } = createSession();
      const ctx = makeCtx();

      // First call sets name
      mockGetActiveAgentName.mockReturnValue("first-agent");
      session.resolveAgentName(ctx);

      // Second call with no name resolves to last known
      mockGetActiveAgentName.mockReturnValue(null);
      mockGetActiveAgentNameFromSystemPrompt.mockReturnValue(null);
      expect(session.resolveAgentName(ctx)).toBe("first-agent");
    });

    it("exposes lastKnownActiveAgentName", () => {
      const { session } = createSession();
      expect(session.lastKnownActiveAgentName).toBeNull();

      mockGetActiveAgentName.mockReturnValue("named");
      session.resolveAgentName(makeCtx());
      expect(session.lastKnownActiveAgentName).toBe("named");
    });
  });

  describe("infrastructure paths", () => {
    it("getInfrastructureReadDirs combines piInfrastructureDirs and piInfrastructureReadPaths", () => {
      const configStore = makeConfigStore({
        current: vi.fn().mockReturnValue({
          piInfrastructureReadPaths: ["/extra/path"],
        }),
      });
      const { session } = createSession({ configStore });
      expect(session.getInfrastructureReadDirs()).toEqual([
        "/test/agent",
        "/test/agent/git",
        "/extra/path",
      ]);
    });

    it("getInfrastructureReadDirs returns only piInfrastructureDirs when config omits the field", () => {
      const { session } = createSession();
      expect(session.getInfrastructureReadDirs()).toEqual([
        "/test/agent",
        "/test/agent/git",
      ]);
    });
  });

  describe("config delegation", () => {
    it("refreshConfig delegates to configStore.refresh", () => {
      const { session, configStore } = createSession();
      const ctx = makeCtx();
      session.refreshConfig(ctx);
      expect(configStore.refresh).toHaveBeenCalledWith(ctx);
    });

    it("logResolvedConfigPaths delegates to configStore.logResolvedPaths", () => {
      const { session, configStore } = createSession();
      session.logResolvedConfigPaths();
      expect(configStore.logResolvedPaths).toHaveBeenCalled();
    });

    it("config getter delegates to configStore.current()", () => {
      const fakeConfig = { debugLog: true } as typeof DEFAULT_EXTENSION_CONFIG;
      const configStore = makeConfigStore({
        current: vi.fn().mockReturnValue(fakeConfig),
      });
      const { session } = createSession({ configStore });
      expect(session.config).toBe(fakeConfig);
    });

    it("getToolPreviewLimits returns resolved preview limits from config", () => {
      const configStore = makeConfigStore({
        current: vi.fn().mockReturnValue({
          toolInputPreviewMaxLength: 400,
          toolTextSummaryMaxLength: 120,
        }),
      });
      const { session } = createSession({ configStore });
      const limits = session.getToolPreviewLimits();
      expect(limits.toolInputPreviewMaxLength).toBe(400);
      expect(limits.toolTextSummaryMaxLength).toBe(120);
    });

    it("getToolPreviewLimits falls back to built-in defaults when config omits fields", () => {
      const { session } = createSession();
      const limits = session.getToolPreviewLimits();
      expect(limits.toolInputPreviewMaxLength).toBeGreaterThan(0);
      expect(limits.toolTextSummaryMaxLength).toBeGreaterThan(0);
      expect(limits.toolInputLogPreviewMaxLength).toBeGreaterThan(0);
    });
  });

  describe("reload", () => {
    it("configures PermissionManager for current context cwd", () => {
      const pm = makePermissionManager();
      const { session } = createSession({ permissionManager: pm });
      const ctx = makeCtx({ cwd: "/project" });
      session.activate(ctx);

      session.reload();

      expect(pm.configureForCwd).toHaveBeenCalledWith("/project");
    });

    it("clears skill entries", () => {
      const { session } = createSession();
      session.setActiveSkillEntries([makeSkillEntry("s")]);

      session.reload();

      expect(session.getActiveSkillEntries()).toEqual([]);
    });
  });

  describe("getRuntimeContext", () => {
    it("returns null before activation", () => {
      const { session } = createSession();
      expect(session.getRuntimeContext()).toBeNull();
    });

    it("returns context after activation", () => {
      const { session } = createSession();
      const ctx = makeCtx();
      session.activate(ctx);
      expect(session.getRuntimeContext()).toBe(ctx);
    });

    it("returns null after deactivation", () => {
      const { session } = createSession();
      session.activate(makeCtx());
      session.deactivate();
      expect(session.getRuntimeContext()).toBeNull();
    });
  });

  describe("notify", () => {
    it("forwards the message to ctx.ui.notify with 'warning' severity after activation", () => {
      const { session } = createSession();
      const ctx = makeCtx();
      session.activate(ctx);

      session.notify("something went wrong");

      expect(ctx.ui.notify).toHaveBeenCalledOnce();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "something went wrong",
        "warning",
      );
    });

    it("is a no-op and does not throw before activation", () => {
      const { session } = createSession();

      expect(() => session.notify("msg")).not.toThrow();
    });

    it("is a no-op and does not throw after deactivation", () => {
      const { session } = createSession();
      const ctx = makeCtx();
      session.activate(ctx);
      session.deactivate();

      expect(() => session.notify("msg")).not.toThrow();
    });
  });
});
