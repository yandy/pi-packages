import { join } from "node:path";
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
// Default implementation is identity — existing lexical tests are unaffected.
const realpathSync = vi.hoisted(() => vi.fn<(path: string) => string>((p) => p));
vi.mock("node:fs", () => ({
	realpathSync,
	default: { realpathSync },
}));

import {
	canonicalNormalizePathForComparison,
	getPathBearingToolPath,
	getPathPolicyValues,
	getToolInputPath,
	isPathOutsideWorkingDirectory,
	isPathWithinDirectory,
	isPiInfrastructureRead,
	isSafeSystemPath,
	normalizePathForComparison,
	normalizePathPolicyLiteral,
	PATH_BEARING_TOOLS,
	READ_ONLY_PATH_BEARING_TOOLS,
	SAFE_SYSTEM_PATHS,
} from "../src/path-utils";
import type { ToolAccessExtractorLookup } from "../src/tool-access-extractor-registry";

describe("normalizePathForComparison", () => {
	const cwd = "/projects/my-app";

	test("resolves absolute path unchanged", () => {
		expect(normalizePathForComparison("/usr/local/bin", cwd)).toBe("/usr/local/bin");
	});

	test("resolves relative path against cwd", () => {
		expect(normalizePathForComparison("src/foo.ts", cwd)).toBe("/projects/my-app/src/foo.ts");
	});

	test("expands bare ~ to homedir", () => {
		expect(normalizePathForComparison("~", cwd)).toBe("/mock/home");
	});

	test("expands ~/... to homedir-relative path", () => {
		expect(normalizePathForComparison("~/docs/readme.md", cwd)).toBe(join("/mock/home", "docs/readme.md"));
	});

	test("expands bare $HOME to homedir", () => {
		expect(normalizePathForComparison("$HOME", cwd)).toBe("/mock/home");
	});

	test("expands $HOME/... to homedir-relative path", () => {
		expect(normalizePathForComparison("$HOME/.ssh/config", cwd)).toBe(join("/mock/home", ".ssh/config"));
	});

	test("strips leading @ before resolving", () => {
		expect(normalizePathForComparison("@/usr/local/bin", cwd)).toBe("/usr/local/bin");
	});

	test("strips surrounding quotes", () => {
		expect(normalizePathForComparison("'/usr/local/bin'", cwd)).toBe("/usr/local/bin");
		expect(normalizePathForComparison('"/usr/local/bin"', cwd)).toBe("/usr/local/bin");
	});

	test("returns empty string for blank/whitespace-only path", () => {
		expect(normalizePathForComparison("", cwd)).toBe("");
		expect(normalizePathForComparison("   ", cwd)).toBe("");
	});
});

describe("isPathWithinDirectory", () => {
	test("returns true when path equals directory", () => {
		expect(isPathWithinDirectory("/a/b", "/a/b")).toBe(true);
	});

	test("returns true when path is a direct child", () => {
		expect(isPathWithinDirectory("/a/b/c", "/a/b")).toBe(true);
	});

	test("returns true when path is a deep descendant", () => {
		expect(isPathWithinDirectory("/a/b/c/d/e", "/a/b")).toBe(true);
	});

	test("returns false when path is a sibling directory", () => {
		expect(isPathWithinDirectory("/a/bc", "/a/b")).toBe(false);
	});

	test("returns false when path is outside the directory", () => {
		expect(isPathWithinDirectory("/other/path", "/a/b")).toBe(false);
	});

	test("returns false for empty path", () => {
		expect(isPathWithinDirectory("", "/a/b")).toBe(false);
	});

	test("returns false for empty directory", () => {
		expect(isPathWithinDirectory("/a/b", "")).toBe(false);
	});

	// ── platform-aware containment (Windows is case-insensitive) ────────────

	test("win32: folds case for a case-different descendant", () => {
		expect(isPathWithinDirectory("c:\\users\\foo\\dir\\sub\\x.md", "C:\\Users\\Foo\\dir", "win32")).toBe(true);
	});

	test("win32: folds case when path equals directory in different case", () => {
		expect(isPathWithinDirectory("c:\\users\\foo\\dir\\sub", "C:\\USERS\\foo\\DIR", "win32")).toBe(true);
	});

	test("win32: rejects a sibling directory", () => {
		expect(isPathWithinDirectory("C:\\Users\\Foo\\other", "C:\\Users\\Foo\\dir", "win32")).toBe(false);
	});

	test("posix platform stays case-sensitive", () => {
		expect(isPathWithinDirectory("/a/B/c", "/a/b", "linux")).toBe(false);
	});
});

describe("PATH_BEARING_TOOLS", () => {
	test("contains the expected tool names", () => {
		for (const tool of ["read", "write", "edit", "find", "grep", "ls"]) {
			expect(PATH_BEARING_TOOLS.has(tool)).toBe(true);
		}
	});

	test("does not contain bash or mcp", () => {
		expect(PATH_BEARING_TOOLS.has("bash")).toBe(false);
		expect(PATH_BEARING_TOOLS.has("mcp")).toBe(false);
	});
});

describe("READ_ONLY_PATH_BEARING_TOOLS", () => {
	test("contains read, find, grep, ls", () => {
		for (const tool of ["read", "find", "grep", "ls"]) {
			expect(READ_ONLY_PATH_BEARING_TOOLS.has(tool)).toBe(true);
		}
	});

	test("does not contain write or edit", () => {
		expect(READ_ONLY_PATH_BEARING_TOOLS.has("write")).toBe(false);
		expect(READ_ONLY_PATH_BEARING_TOOLS.has("edit")).toBe(false);
	});
});

describe("SAFE_SYSTEM_PATHS", () => {
	test("contains /dev/null, /dev/stdin, /dev/stdout, /dev/stderr", () => {
		expect(SAFE_SYSTEM_PATHS.has("/dev/null")).toBe(true);
		expect(SAFE_SYSTEM_PATHS.has("/dev/stdin")).toBe(true);
		expect(SAFE_SYSTEM_PATHS.has("/dev/stdout")).toBe(true);
		expect(SAFE_SYSTEM_PATHS.has("/dev/stderr")).toBe(true);
	});
});

describe("isSafeSystemPath", () => {
	test("returns true for /dev/null", () => {
		expect(isSafeSystemPath("/dev/null")).toBe(true);
	});

	test("returns true for /dev/stdin", () => {
		expect(isSafeSystemPath("/dev/stdin")).toBe(true);
	});

	test("returns true for /dev/stdout", () => {
		expect(isSafeSystemPath("/dev/stdout")).toBe(true);
	});

	test("returns true for /dev/stderr", () => {
		expect(isSafeSystemPath("/dev/stderr")).toBe(true);
	});

	test("returns false for an arbitrary absolute path", () => {
		expect(isSafeSystemPath("/etc/passwd")).toBe(false);
	});

	test("returns false for a path prefixed with a safe system path", () => {
		expect(isSafeSystemPath("/dev/null/subdir")).toBe(false);
	});

	test("returns false for an empty string", () => {
		expect(isSafeSystemPath("")).toBe(false);
	});

	test("returns false for a relative path", () => {
		expect(isSafeSystemPath("dev/null")).toBe(false);
	});
});

describe("getPathBearingToolPath", () => {
	test("returns path for a path-bearing tool", () => {
		expect(getPathBearingToolPath("read", { path: "/src/foo.ts" })).toBe("/src/foo.ts");
	});

	test("returns null for a non-path-bearing tool", () => {
		expect(getPathBearingToolPath("bash", { path: "/src/foo.ts" })).toBeNull();
		expect(getPathBearingToolPath("mcp", { path: "/src/foo.ts" })).toBeNull();
		expect(getPathBearingToolPath("task", { path: "/src/foo.ts" })).toBeNull();
	});

	test("returns null when input has no path", () => {
		expect(getPathBearingToolPath("read", {})).toBeNull();
		expect(getPathBearingToolPath("read", { path: "" })).toBeNull();
		expect(getPathBearingToolPath("read", null)).toBeNull();
	});
});

describe("getToolInputPath", () => {
	function lookupOf(
		toolName: string,
		extractor: (input: Record<string, unknown>) => string | undefined,
	): ToolAccessExtractorLookup {
		return {
			get: (name) => (name === toolName ? extractor : undefined),
		};
	}

	test("returns input.path for a built-in path-bearing tool", () => {
		expect(getToolInputPath("read", { path: "/src/foo.ts" })).toBe("/src/foo.ts");
		expect(getToolInputPath("write", { path: "/src/bar.ts" })).toBe("/src/bar.ts");
	});

	test("returns null for bash", () => {
		expect(getToolInputPath("bash", { path: "/src/foo.ts" })).toBeNull();
	});

	test("returns the MCP arguments.path for an mcp call", () => {
		expect(getToolInputPath("mcp", { arguments: { path: "/etc/hosts" } })).toBe("/etc/hosts");
	});

	test("returns null for an mcp call without an arguments.path", () => {
		expect(getToolInputPath("mcp", { arguments: { query: "x" } })).toBeNull();
		expect(getToolInputPath("mcp", {})).toBeNull();
	});

	test("defaults to input.path for an unregistered extension tool", () => {
		expect(getToolInputPath("my-ext", { path: "/work/file.txt" })).toBe("/work/file.txt");
	});

	test("returns null for an extension tool without a path", () => {
		expect(getToolInputPath("my-ext", { other: true })).toBeNull();
		expect(getToolInputPath("my-ext", { path: "" })).toBeNull();
		expect(getToolInputPath("my-ext", null)).toBeNull();
	});

	test("uses a registered extractor's path over the default convention", () => {
		const extractors = lookupOf("ffgrep", (input) => (typeof input.target === "string" ? input.target : undefined));
		expect(getToolInputPath("ffgrep", { target: "/etc/passwd" }, extractors)).toBe("/etc/passwd");
	});

	test("returns null when a registered extractor declines", () => {
		const extractors = lookupOf("ffgrep", () => undefined);
		expect(getToolInputPath("ffgrep", { target: "x" }, extractors)).toBeNull();
	});
});

describe("isPathOutsideWorkingDirectory", () => {
	const cwd = "/projects/my-app";

	beforeEach(() => {
		// Reset then restore the identity default so symlink tests don't bleed.
		realpathSync.mockReset();
		realpathSync.mockImplementation((p: string) => p);
	});

	test("returns false when path is inside cwd", () => {
		expect(isPathOutsideWorkingDirectory("/projects/my-app/src", cwd)).toBe(false);
	});

	test("returns false when path equals cwd", () => {
		expect(isPathOutsideWorkingDirectory("/projects/my-app", cwd)).toBe(false);
	});

	test("returns true when path is outside cwd", () => {
		expect(isPathOutsideWorkingDirectory("/etc/passwd", cwd)).toBe(true);
	});

	test("returns true for home directory when outside cwd", () => {
		expect(isPathOutsideWorkingDirectory("~/secrets", cwd)).toBe(true);
	});

	test("returns false for relative path resolving inside cwd", () => {
		expect(isPathOutsideWorkingDirectory("src/index.ts", cwd)).toBe(false);
	});

	test("returns false for empty path (normalizes to empty string)", () => {
		expect(isPathOutsideWorkingDirectory("", cwd)).toBe(false);
	});

	test("returns false for /dev/null regardless of cwd", () => {
		expect(isPathOutsideWorkingDirectory("/dev/null", cwd)).toBe(false);
	});

	test("returns false for /dev/stdin regardless of cwd", () => {
		expect(isPathOutsideWorkingDirectory("/dev/stdin", cwd)).toBe(false);
	});

	test("returns false for /dev/stdout regardless of cwd", () => {
		expect(isPathOutsideWorkingDirectory("/dev/stdout", cwd)).toBe(false);
	});

	test("returns false for /dev/stderr regardless of cwd", () => {
		expect(isPathOutsideWorkingDirectory("/dev/stderr", cwd)).toBe(false);
	});

	test("returns true for /dev/null/subdir (not a safe path)", () => {
		expect(isPathOutsideWorkingDirectory("/dev/null/subdir", cwd)).toBe(true);
	});

	test("returns true for in-cwd symlink that resolves to external path", () => {
		// ./link -> /etc: realpathSync resolves the full token in one call.
		realpathSync.mockImplementation((p: string) => {
			if (p === "/projects/my-app/link/hosts") return "/etc/hosts";
			return p;
		});
		expect(isPathOutsideWorkingDirectory("./link/hosts", cwd)).toBe(true);
	});

	test("returns false for path inside a symlinked cwd", () => {
		// /tmp -> /private/tmp on macOS; cwd reported as /private/tmp.
		const symlinkCwd = "/private/tmp";
		realpathSync.mockImplementation((p: string) => {
			if (p.startsWith("/tmp/")) return "/private/tmp" + p.slice(4);
			if (p === "/tmp") return "/private/tmp";
			return p;
		});
		expect(isPathOutsideWorkingDirectory("/tmp/workspace/file.ts", symlinkCwd)).toBe(false);
	});
});

describe("canonicalNormalizePathForComparison", () => {
	const cwd = "/projects/my-app";

	beforeEach(() => {
		realpathSync.mockReset();
		realpathSync.mockImplementation((p: string) => p);
	});

	test("returns canonical form of an existing path", () => {
		realpathSync.mockImplementation((p: string) => {
			if (p === "/projects/link") return "/real/projects/app";
			return p;
		});
		expect(canonicalNormalizePathForComparison("/projects/link", cwd)).toBe("/real/projects/app");
	});

	test("returns empty string for empty input", () => {
		expect(canonicalNormalizePathForComparison("", cwd)).toBe("");
	});

	test("returns lexical form when no symlinks (identity realpathSync)", () => {
		expect(canonicalNormalizePathForComparison("/projects/my-app/src/index.ts", cwd)).toBe(
			"/projects/my-app/src/index.ts",
		);
	});
});

describe("isPiInfrastructureRead", () => {
	const cwd = "/projects/my-app";
	const infraDirs = ["/mock/home/.pi/agent"];

	test("returns true for read-only tool reading from infra dir", () => {
		expect(isPiInfrastructureRead("read", "/mock/home/.pi/agent/config.json", infraDirs, cwd)).toBe(true);
	});

	test("returns false for write tool even in infra dir", () => {
		expect(isPiInfrastructureRead("write", "/mock/home/.pi/agent/config.json", infraDirs, cwd)).toBe(false);
	});

	test("returns true for read-only tool reading from project .pi/npm", () => {
		expect(isPiInfrastructureRead("read", "/projects/my-app/.pi/npm/package.json", [], cwd)).toBe(true);
	});

	test("returns true for read-only tool reading from project .pi/git", () => {
		expect(isPiInfrastructureRead("grep", "/projects/my-app/.pi/git/some-file", [], cwd)).toBe(true);
	});

	test("returns false for path outside all infra dirs and project dirs", () => {
		expect(isPiInfrastructureRead("read", "/etc/passwd", infraDirs, cwd)).toBe(false);
	});

	// ── glob patterns ─────────────────────────────────────────────────

	test("glob entry matches a versioned path", () => {
		expect(
			isPiInfrastructureRead(
				"read",
				"/opt/homebrew/Cellar/pi-coding-agent/0.74.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/SKILL.md",
				["/opt/homebrew/**/@earendil-works/pi-coding-agent/**"],
				cwd,
			),
		).toBe(true);
	});

	test("glob entry does not match an unrelated path", () => {
		expect(
			isPiInfrastructureRead("read", "/etc/passwd", ["/opt/homebrew/**/@earendil-works/pi-coding-agent/**"], cwd),
		).toBe(false);
	});

	test("plain entry with ~ expands to home dir for matching", () => {
		// node:os is mocked: homedir() returns "/mock/home"
		expect(isPiInfrastructureRead("read", "/mock/home/.pi/agent/config.json", ["~/.pi/agent"], cwd)).toBe(true);
	});

	// ── Windows: case-insensitive infra-read matching ─────────────────────

	test("win32: plain infra dir matches a case-different path", () => {
		expect(
			isPiInfrastructureRead(
				"read",
				"c:\\users\\foo\\.pi\\agent\\config.json",
				["C:\\Users\\Foo\\.pi\\agent"],
				"C:\\proj",
				"win32",
			),
		).toBe(true);
	});

	test("win32: glob infra dir matches case-insensitively", () => {
		expect(
			isPiInfrastructureRead(
				"read",
				"c:\\users\\foo\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\skill.md",
				["C:\\Users\\Foo\\**\\pi-coding-agent\\**"],
				"C:\\proj",
				"win32",
			),
		).toBe(true);
	});

	test("win32: rejects a path outside every infra dir", () => {
		expect(
			isPiInfrastructureRead(
				"read",
				"c:\\windows\\system32\\drivers\\etc\\hosts",
				["C:\\Users\\Foo\\.pi\\agent"],
				"C:\\proj",
				"win32",
			),
		).toBe(false);
	});
});

describe("normalizePathPolicyLiteral", () => {
	test("returns a relative token unchanged", () => {
		expect(normalizePathPolicyLiteral("src/foo.ts")).toBe("src/foo.ts");
	});

	test("trims and strips simple wrapping quotes", () => {
		expect(normalizePathPolicyLiteral("  'src/foo.ts'  ")).toBe("src/foo.ts");
		expect(normalizePathPolicyLiteral('"a/b"')).toBe("a/b");
	});

	test("strips a leading @ prefix", () => {
		expect(normalizePathPolicyLiteral("@src/foo.ts")).toBe("src/foo.ts");
	});

	test("expands ~ to the home directory", () => {
		expect(normalizePathPolicyLiteral("~/docs/readme.md")).toBe(join("/mock/home", "docs/readme.md"));
	});

	test("does not resolve a relative value against any cwd", () => {
		expect(normalizePathPolicyLiteral("foo.ts")).toBe("foo.ts");
	});

	test("returns empty string for blank input", () => {
		expect(normalizePathPolicyLiteral("   ")).toBe("");
	});

	test("preserves the surface catch-all", () => {
		expect(normalizePathPolicyLiteral("*")).toBe("*");
	});
});

describe("getPathPolicyValues", () => {
	const cwd = "/projects/my-app";

	test("returns only the literal when no base is available", () => {
		expect(getPathPolicyValues("src/foo.ts")).toEqual(["src/foo.ts"]);
		expect(getPathPolicyValues("src/foo.ts", {})).toEqual(["src/foo.ts"]);
	});

	test("adds absolute and project-relative aliases for a relative token", () => {
		expect(getPathPolicyValues("src/foo.ts", { cwd })).toEqual(["/projects/my-app/src/foo.ts", "src/foo.ts"]);
	});

	test("omits the relative alias for a token outside cwd", () => {
		expect(getPathPolicyValues("/etc/hosts", { cwd })).toEqual(["/etc/hosts"]);
	});

	test("resolves against resolveBase while aliasing relative to cwd", () => {
		expect(
			getPathPolicyValues("foo.txt", {
				cwd,
				resolveBase: "/projects/my-app/nested",
			}),
		).toEqual(["/projects/my-app/nested/foo.txt", "nested/foo.txt", "foo.txt"]);
	});

	test("preserves the surface catch-all", () => {
		expect(getPathPolicyValues("*", { cwd })).toEqual(["*"]);
	});

	test("returns empty for blank input", () => {
		expect(getPathPolicyValues("   ", { cwd })).toEqual([]);
	});
});
