import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	expandPath,
	getExternalPath,
	hostToContainer,
	isAllowedExternalResource,
	isInsideContainer,
	isReadOnlyMount,
	PathApprovalStore,
	containerToHost,
	requestPathApproval,
	resolveExtraMountPath,
	shq,
	toContainerPath,
} from "../src/paths";
import { homedir } from "node:os";
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

describe("hostToContainer", () => {
	it("converts relative path inside cwd to /workspace path", () => {
		expect(hostToContainer("src/index.ts", testDir)).toBe("/workspace/src/index.ts");
	});
	it("returns /workspace for cwd itself", () => {
		expect(hostToContainer(".", testDir)).toBe("/workspace");
	});
	it("passes through paths already under /workspace", () => {
		expect(hostToContainer("/workspace/src/file.ts", testDir)).toBe("/workspace/src/file.ts");
	});
	it("throws for paths outside cwd", () => {
		expect(() => hostToContainer("/etc/passwd", testDir)).toThrow("outside of project cwd");
	});
	it("passes through paths under a mount target", () => {
		const mounts = [{ source: "/host/skills", target: "/skills/my-skill" }];
		expect(hostToContainer("/skills/my-skill/SKILL.md", testDir, mounts)).toBe("/skills/my-skill/SKILL.md");
	});
});

describe("isInsideContainer", () => {
	it("returns true for relative path inside cwd", () => {
		expect(isInsideContainer("src/file.ts", testDir)).toBe(true);
	});
	it("returns true for /workspace paths", () => {
		expect(isInsideContainer("/workspace/src/file.ts", testDir)).toBe(true);
	});
	it("returns false for paths outside cwd", () => {
		expect(isInsideContainer("/etc/passwd", testDir)).toBe(false);
	});
	it("returns true for /skills root path", () => {
		expect(isInsideContainer("/skills", testDir)).toBe(true);
	});
	it("returns true for /skills sub-paths", () => {
		expect(isInsideContainer("/skills/find-docs/SKILL.md", testDir)).toBe(true);
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

describe("isReadOnlyMount with mode", () => {
	it("returns true for ro mount", () => {
		const mounts: MountSpec[] = [{ source: "/host/data", target: "/data", mode: "ro" }];
		expect(isReadOnlyMount("/data/file.txt", mounts)).toBe(true);
	});
	it("returns false for rw mount", () => {
		const mounts: MountSpec[] = [{ source: "/host/data", target: "/data", mode: "rw" }];
		expect(isReadOnlyMount("/data/file.txt", mounts)).toBe(false);
	});
	it("returns true when mode is not specified (default ro)", () => {
		const mounts: MountSpec[] = [{ source: "/host/data", target: "/data" }];
		expect(isReadOnlyMount("/data/file.txt", mounts)).toBe(true);
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
	it("returns null for /skills root", () => {
		expect(getExternalPath("/skills", testDir, [])).toBeNull();
	});
	it("returns null for /skills sub-paths without mounts", () => {
		expect(getExternalPath("/skills/my-skill/SKILL.md", testDir, [])).toBeNull();
	});
	it("returns null for /skills sub-paths with mounts present", () => {
		const mounts: MountSpec[] = [{ source: "/host/skills", target: "/skills/my-skill" }];
		expect(getExternalPath("/skills/my-skill/SKILL.md", testDir, mounts)).toBeNull();
		expect(getExternalPath("/skills/my-skill", testDir, mounts)).toBeNull();
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

describe("containerToHost", () => {
	const testHostCwd = "/home/user/project";

	it("maps /workspace to hostCwd", () => {
		expect(containerToHost("/workspace", testHostCwd, [])).toBe("/home/user/project");
	});

	it("maps /workspace/src/foo to hostCwd/src/foo", () => {
		expect(containerToHost("/workspace/src/foo.ts", testHostCwd, [])).toBe("/home/user/project/src/foo.ts");
	});

	it("passes through non-container absolute paths unchanged", () => {
		expect(containerToHost("/home/user/project/src/foo.ts", testHostCwd, [])).toBe("/home/user/project/src/foo.ts");
	});

	it("passes through relative paths unchanged", () => {
		expect(containerToHost("src/foo.ts", testHostCwd, [])).toBe("src/foo.ts");
	});

	it("maps /skills/<name>/... to mount source", () => {
		const mounts = [{ source: "/opt/skills/my-skill", target: "/skills/my-skill" }];
		expect(containerToHost("/skills/my-skill/SKILL.md", testHostCwd, mounts)).toBe("/opt/skills/my-skill/SKILL.md");
	});

	it("maps /skills/<name> to mount source root", () => {
		const mounts = [{ source: "/opt/skills/my-skill", target: "/skills/my-skill" }];
		expect(containerToHost("/skills/my-skill", testHostCwd, mounts)).toBe("/opt/skills/my-skill");
	});

	it("throws for unmapped /skills path", () => {
		expect(() => containerToHost("/skills/unknown/file", "/home/user", [])).toThrow("Cannot map container path");
	});
});

describe("requestPathApproval", () => {
	it("select dialog title includes the path being approved", async () => {
		const testPath = "/home/user/sensitive-file.txt";
		let capturedTitle = "";

		const mockUi = {
			select: async (title: string, _options: string[]) => {
				capturedTitle = title;
				return "Deny";
			},
			notify: () => {},
		};

		const store = new PathApprovalStore(testDir);
		await requestPathApproval(testPath, [], store, mockUi);

		expect(capturedTitle).toContain(testPath);
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

describe("expandPath", () => {
	const cwd = "/home/user/project";

	it("expands ~ to homedir", () => {
		expect(expandPath("~")).toBe(homedir());
	});

	it("expands ~/path to homedir + /path", () => {
		expect(expandPath("~/data/projects")).toBe(homedir() + "/data/projects");
	});

	it("~ takes precedence over cwd — cwd is ignored for ~ paths", () => {
		expect(expandPath("~/data", "/other/cwd")).toBe(homedir() + "/data");
		expect(expandPath("~", "/other/cwd")).toBe(homedir());
	});

	it("does not expand ~otheruser", () => {
		expect(expandPath("~otheruser/stuff")).toBe("~otheruser/stuff");
	});

	it("leaves absolute paths unchanged", () => {
		expect(expandPath("/absolute/path")).toBe("/absolute/path");
	});

	it("resolves relative path against cwd", () => {
		expect(expandPath("./relative/dir", cwd)).toBe("/home/user/project/relative/dir");
	});

	it("resolves ../parent against cwd", () => {
		expect(expandPath("../sibling", cwd)).toBe("/home/user/sibling");
	});

	it("resolves plain relative path (no ./) against cwd", () => {
		expect(expandPath("foo/bar", cwd)).toBe("/home/user/project/foo/bar");
	});

	it("returns relative path as-is when cwd is not provided", () => {
		expect(expandPath("./cache")).toBe("./cache");
		expect(expandPath("../cache")).toBe("../cache");
	});

	it("does NOT expand ${userHome} — treat as literal", () => {
		expect(expandPath("${userHome}/data")).toBe("${userHome}/data");
	});

	it("${userHome} with cwd resolves as relative path", () => {
		expect(expandPath("${userHome}/data", cwd)).toBe("/home/user/project/${userHome}/data");
	});

	it("does not expand ${userhome} (case-sensitive)", () => {
		expect(expandPath("${userhome}/data")).toBe("${userhome}/data");
	});

	it("does not expand ${USER_HOME} (case-sensitive)", () => {
		expect(expandPath("${USER_HOME}/data")).toBe("${USER_HOME}/data");
	});
});
