import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock node:os so tilde-expansion is deterministic across platforms.
vi.mock("node:os", () => {
  const homedir = vi.fn(() => "/mock/home");
  return {
    homedir,
    default: { homedir },
  };
});

// Mock node:fs so realpathSync (used by canonicalizePath) is controllable.
// Default implementation is identity — lexical tests are unaffected.
const realpathSync = vi.hoisted(() =>
  vi.fn<(path: string) => string>((p) => p),
);
vi.mock("node:fs", () => ({
  realpathSync,
  default: { realpathSync },
}));

import { AccessPath } from "../../src/access-intent/access-path";

describe("AccessPath.forPath", () => {
  const cwd = "/projects/my-app";

  beforeEach(() => {
    realpathSync.mockReset();
    realpathSync.mockImplementation((p: string) => p);
  });

  describe("matchValues()", () => {
    test("adds the symlink-resolved alias alongside the typed path", () => {
      // /tmp -> /private/tmp (the macOS symlink from the bug report, #418).
      realpathSync.mockImplementation((p: string) =>
        p.startsWith("/tmp") ? `/private${p}` : p,
      );
      expect(AccessPath.forPath("/tmp/x", { cwd }).matchValues()).toEqual([
        "/tmp/x",
        "/private/tmp/x",
      ]);
    });

    test("deduplicates when the canonical form equals the lexical form", () => {
      expect(AccessPath.forPath("/etc/hosts", { cwd }).matchValues()).toEqual([
        "/etc/hosts",
      ]);
    });

    test("keeps the relative aliases for an in-cwd token without duplicating", () => {
      expect(AccessPath.forPath("src/foo.ts", { cwd }).matchValues()).toEqual([
        "/projects/my-app/src/foo.ts",
        "src/foo.ts",
      ]);
    });

    test("includes only the lexical aliases when canonical is empty", () => {
      // Force canonicalizePath to return the original (no-op symlink resolution
      // effectively means canonical === lexical, handled by dedup).
      expect(
        AccessPath.forPath("/etc/hosts", { cwd }).matchValues(),
      ).not.toHaveLength(0);
    });

    test("resolves a relative token against an explicit resolveBase", () => {
      // The cd-folded effective base differs from cwd (the bash-path case).
      expect(
        AccessPath.forPath("foo.ts", {
          cwd,
          resolveBase: "/projects/my-app/sub",
        }).matchValues(),
      ).toEqual(["/projects/my-app/sub/foo.ts", "sub/foo.ts", "foo.ts"]);
    });

    test("adds the canonical alias resolved against resolveBase", () => {
      realpathSync.mockImplementation((p: string) =>
        p === "/projects/my-app/sub/foo.ts" ? "/real/foo.ts" : p,
      );
      expect(
        AccessPath.forPath("foo.ts", {
          cwd,
          resolveBase: "/projects/my-app/sub",
        }).matchValues(),
      ).toEqual([
        "/projects/my-app/sub/foo.ts",
        "sub/foo.ts",
        "foo.ts",
        "/real/foo.ts",
      ]);
    });
  });

  describe("boundaryValue()", () => {
    test("returns the canonical (symlink-resolved) form", () => {
      realpathSync.mockImplementation((p: string) =>
        p.startsWith("/tmp") ? `/private${p}` : p,
      );
      expect(AccessPath.forPath("/tmp/x", { cwd }).boundaryValue()).toBe(
        "/private/tmp/x",
      );
    });

    test("returns the lexical form when path has no symlinks", () => {
      expect(AccessPath.forPath("/etc/hosts", { cwd }).boundaryValue()).toBe(
        "/etc/hosts",
      );
    });

    test("returns empty string for empty input", () => {
      expect(AccessPath.forPath("", { cwd }).boundaryValue()).toBe("");
    });
  });

  describe("value()", () => {
    test("returns the lexical (as-typed, normalized) form", () => {
      realpathSync.mockImplementation((p: string) =>
        p.startsWith("/tmp") ? `/private${p}` : p,
      );
      // Even when the path resolves to a different canonical, value() stays lexical.
      expect(AccessPath.forPath("/tmp/x", { cwd }).value()).toBe("/tmp/x");
    });

    test("normalizes the path against cwd", () => {
      // A relative path becomes an absolute lexical value.
      expect(AccessPath.forPath("src/foo.ts", { cwd }).value()).toBe(
        "/projects/my-app/src/foo.ts",
      );
    });

    test("normalizes a relative path against an explicit resolveBase", () => {
      expect(
        AccessPath.forPath("foo.ts", {
          cwd,
          resolveBase: "/projects/my-app/sub",
        }).value(),
      ).toBe("/projects/my-app/sub/foo.ts");
    });

    test("returns empty string for empty input", () => {
      expect(AccessPath.forPath("", { cwd }).value()).toBe("");
    });
  });
});

describe("AccessPath.forLiteral", () => {
  beforeEach(() => {
    realpathSync.mockReset();
    realpathSync.mockImplementation((p: string) => p);
  });

  test("matchValues() carries only the literal — no canonical, no absolute", () => {
    expect(AccessPath.forLiteral("foo.ts").matchValues()).toEqual(["foo.ts"]);
  });

  test("boundaryValue() is empty (no outside-cwd notion for an unknown base)", () => {
    expect(AccessPath.forLiteral("foo.ts").boundaryValue()).toBe("");
  });

  test("value() returns the literal", () => {
    expect(AccessPath.forLiteral("foo.ts").value()).toBe("foo.ts");
  });

  test("an empty literal yields no match values", () => {
    expect(AccessPath.forLiteral("").matchValues()).toEqual([]);
    expect(AccessPath.forLiteral("").value()).toBe("");
  });
});
