import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getExternalPath,
	hostToRemote,
	isAllowedExternalResource,
	isInsideCwd,
	isReadOnlyMount,
	PathApprovalStore,
	remoteToHost,
	resolveExtraMountPath,
	shq,
	toContainerPath,
} from "../src/paths";
import type { MountSpec } from "../src/runtime";

const testDir = resolvePath(tmpdir(), `pi-paths-test-${Date.now()}`);

beforeEach(() => {
	if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("shq", () => {
	it("wraps string in single quotes", () => {
		expect(shq("hello")).toBe("'hello'");
	});
	it("escapes embedded single quotes", () => {
		expect(shq("it's")).toBe("'it'\\''s'");
	});
});

describe("toRemote", () => {
	it("converts relative path inside cwd to /workspace path", () => {
		expect(hostToRemote("src/index.ts", testDir)).toBe("/workspace/src/index.ts");
	});
	it("returns /workspace for cwd itself", () => {
		expect(hostToRemote(".", testDir)).toBe("/workspace");
	});
	it("passes through paths already under /workspace", () => {
		expect(hostToRemote("/workspace/src/file.ts", testDir)).toBe("/workspace/src/file.ts");
	});
	it("throws for paths outside cwd", () => {
		expect(() => hostToRemote("/etc/passwd", testDir)).toThrow("outside of project cwd");
	});
	it("passes through paths under a mount target", () => {
		const mounts = [{ source: "/host/skills", target: "/skills/my-skill" }];
		expect(hostToRemote("/skills/my-skill/SKILL.md", testDir, mounts)).toBe("/skills/my-skill/SKILL.md");
	});
});

describe("isInsideCwd", () => {
	it("returns true for relative path inside cwd", () => {
		expect(isInsideCwd("src/file.ts", testDir)).toBe(true);
	});
	it("returns true for /workspace paths", () => {
		expect(isInsideCwd("/workspace/src/file.ts", testDir)).toBe(true);
	});
	it("returns false for paths outside cwd", () => {
		expect(isInsideCwd("/etc/passwd", testDir)).toBe(false);
	});
});

describe("isReadOnlyMount", () => {
	const mounts = [{ source: "/host/skills", target: "/skills/my-skill" }];
	it("returns true for exact mount target match", () => {
		expect(isReadOnlyMount("/skills/my-skill", mounts)).toBe(true);
	});
	it("returns true for path under mount target", () => {
		expect(isReadOnlyMount("/skills/my-skill/SKILL.md", mounts)).toBe(true);
	});
	it("returns false for unrelated path", () => {
		expect(isReadOnlyMount("/workspace/src/file.ts", mounts)).toBe(false);
	});
});

describe("resolveExtraMountPath", () => {
	const mounts = [{ source: "/h/a", target: "/mnt/a" }];
	it("returns path if it matches a mount target", () => {
		expect(resolveExtraMountPath("/mnt/a", mounts)).toBe("/mnt/a");
		expect(resolveExtraMountPath("/mnt/a/file.txt", mounts)).toBe("/mnt/a/file.txt");
	});
	it("returns null for unrelated path", () => {
		expect(resolveExtraMountPath("/other/path", mounts)).toBeNull();
	});
});

describe("getExternalPath", () => {
	it("returns null for paths inside cwd", () => {
		expect(getExternalPath("src/file.ts", testDir, [])).toBeNull();
	});
	it("returns absolute path for paths outside cwd", () => {
		expect(getExternalPath("/etc/hosts", testDir, [])).toBe("/etc/hosts");
	});
	it("returns null for /workspace paths", () => {
		expect(getExternalPath("/workspace/src/file.ts", testDir, [])).toBeNull();
	});
});

describe("isAllowedExternalResource", () => {
	it("allows pi-clipboard files", () => {
		expect(isAllowedExternalResource("/tmp/pi-clipboard-12345.txt", [])).toBe(true);
	});
	it("allows paths matching a prefix", () => {
		expect(isAllowedExternalResource("/home/user/downloads/file.txt", ["/home/user/downloads"])).toBe(true);
	});
	it("denies unrelated paths", () => {
		expect(isAllowedExternalResource("/etc/passwd", [])).toBe(false);
	});
});

describe("PathApprovalStore", () => {
	it("starts with no records", () => {
		const store = new PathApprovalStore(testDir);
		expect(store.list()).toEqual([]);
	});
	it("adds and finds records", () => {
		const store = new PathApprovalStore(testDir);
		store.add("/tmp/foo", Infinity);
		const found = store.find("/tmp/foo");
		expect(found).toBeDefined();
		expect(found?.path).toBe("/tmp/foo");
	});
	it("revokes records", () => {
		const store = new PathApprovalStore(testDir);
		store.add("/tmp/foo", Infinity);
		expect(store.revoke("/tmp/foo")).toBe(true);
		expect(store.find("/tmp/foo")).toBeUndefined();
	});
	it("lists active records", () => {
		const store = new PathApprovalStore(testDir);
		store.add("/tmp/a", Infinity);
		store.add("/tmp/b", 30);
		expect(store.list().length).toBe(2);
	});
	it("prefix matching finds child paths", () => {
		const store = new PathApprovalStore(testDir);
		store.add("/tmp/approved-dir", Infinity);
		const found = store.find("/tmp/approved-dir/sub/file.txt");
		expect(found).toBeDefined();
		expect(found?.path).toBe("/tmp/approved-dir");
	});
	it("expired records are not returned", () => {
		const store = new PathApprovalStore(testDir);
		store.add("/tmp/expired", -1);
		expect(store.find("/tmp/expired")).toBeUndefined();
		expect(store.list()).toEqual([]);
	});
	it("persists and reloads from disk", () => {
		const store1 = new PathApprovalStore(testDir);
		store1.add("/tmp/persisted", Infinity);
		const store2 = new PathApprovalStore(testDir);
		expect(store2.find("/tmp/persisted")).toBeDefined();
	});
});

describe("toContainerPath", () => {
	const hostCwd = "/home/user/project";
	const mounts: MountSpec[] = [{ source: "/home/user/.agents/skills/my-skill", target: "/skills/my-skill" }];

	it("maps host cwd path to /workspace", () => {
		const result = toContainerPath("src/file.ts", hostCwd, []);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.path).toBe("/workspace/src/file.ts");
	});

	it("maps a skill mount path", () => {
		const result = toContainerPath("/home/user/.agents/skills/my-skill/SKILL.md", hostCwd, mounts);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.path).toBe("/skills/my-skill/SKILL.md");
	});

	it("rejects path outside cwd and mounts", () => {
		const result = toContainerPath("/etc/passwd", hostCwd, mounts);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("escapes sandbox");
	});

	it("passes through paths already in /workspace or /skills", () => {
		expect(toContainerPath("/workspace/foo", hostCwd, []).ok).toBe(true);
		expect(toContainerPath("/skills/x", hostCwd, []).ok).toBe(true);
	});
});

describe("remoteToHost", () => {
	const testHostCwd = "/home/user/project";

	it("maps /workspace to hostCwd", () => {
		expect(remoteToHost("/workspace", testHostCwd, [])).toBe("/home/user/project");
	});

	it("maps /workspace/src/foo to hostCwd/src/foo", () => {
		expect(remoteToHost("/workspace/src/foo.ts", testHostCwd, [])).toBe("/home/user/project/src/foo.ts");
	});

	it("passes through non-container absolute paths unchanged", () => {
		expect(remoteToHost("/home/user/project/src/foo.ts", testHostCwd, [])).toBe("/home/user/project/src/foo.ts");
	});

	it("passes through relative paths unchanged", () => {
		expect(remoteToHost("src/foo.ts", testHostCwd, [])).toBe("src/foo.ts");
	});

	it("maps /skills/<name>/... to mount source", () => {
		const mounts = [{ source: "/opt/skills/my-skill", target: "/skills/my-skill" }];
		expect(remoteToHost("/skills/my-skill/SKILL.md", testHostCwd, mounts)).toBe("/opt/skills/my-skill/SKILL.md");
	});

	it("maps /skills/<name> to mount source root", () => {
		const mounts = [{ source: "/opt/skills/my-skill", target: "/skills/my-skill" }];
		expect(remoteToHost("/skills/my-skill", testHostCwd, mounts)).toBe("/opt/skills/my-skill");
	});

	it("throws for unmapped /skills path", () => {
		expect(() => remoteToHost("/skills/unknown/file", "/home/user", [])).toThrow("Cannot map container path");
	});
});

describe("PathApprovalStore merge-on-conflict", () => {
	it("merges external additions on save", () => {
		const dir = `${tmpdir()}/pi-test-approvals-${Date.now()}`;
		mkdirSync(dir, { recursive: true });

		const store1 = new PathApprovalStore(dir);
		store1.add("/foo", Infinity);

		const store2 = new PathApprovalStore(dir);
		store2.add("/bar", Infinity);

		const store3 = new PathApprovalStore(dir);
		const found = store3.find("/bar");
		expect(found).toBeDefined();
		expect(found?.path).toBe("/bar");

		rmSync(dir, { recursive: true, force: true });
	});
});
