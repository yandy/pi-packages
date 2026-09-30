import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { projectDirName, projectHash, resolveMemoryDir, safeTopicPath } from "../src/paths";

describe("projectHash", () => {
	it("returns 12 hex chars", async () => {
		const h = await projectHash("/tmp/some-nonexistent-cwd-xyz");
		expect(h).toMatch(/^[0-9a-f]{12}$/);
	});
	it("is deterministic for the same cwd", async () => {
		expect(await projectHash("/tmp/some-nonexistent-cwd-xyz")).toBe(await projectHash("/tmp/some-nonexistent-cwd-xyz"));
	});
	it("differs for different cwd", async () => {
		expect(await projectHash("/tmp/a")).not.toBe(await projectHash("/tmp/b"));
	});
});

describe("resolveMemoryDir", () => {
	it("joins memoryDir with projectHash", async () => {
		const dir = await resolveMemoryDir({ memoryDir: "/tmp/mem" }, "/tmp/proj");
		const h = await projectHash("/tmp/proj");
		expect(dir).toBe(join("/tmp/mem", h));
	});
});

describe("safeTopicPath", () => {
	it("accepts a normal filename", () => {
		expect(safeTopicPath("/tmp/mem/abc", "debugging.md")).toBe(join("/tmp/mem/abc", "debugging.md"));
	});
	it("throws on path traversal with ..", () => {
		expect(() => safeTopicPath("/tmp/mem/abc", "../etc/passwd")).toThrow();
	});
	it("throws on absolute path", () => {
		expect(() => safeTopicPath("/tmp/mem/abc", "/etc/passwd")).toThrow();
	});
	it("throws on backslash traversal", () => {
		expect(() => safeTopicPath("/tmp/mem/abc", "..\\..\\etc")).toThrow();
	});
});

describe("projectDirName", () => {
	it("joins git keys with double underscores", () => {
		expect(projectDirName("github.com/yandy/pi-packages")).toBe("github.com__yandy__pi-packages");
	});

	it("drops the leading slash of absolute paths", () => {
		expect(projectDirName("/home/yandy/workspace/scratch")).toBe("home__yandy__workspace__scratch");
	});

	it("keeps subgroup paths", () => {
		expect(projectDirName("gitlab.com/foo/bar/repo")).toBe("gitlab.com__foo__bar__repo");
	});

	it("escapes characters that are unsafe in file names", () => {
		expect(projectDirName("/home/yandy/proj/with:colon")).toBe("home__yandy__proj__with_3acolon");
	});

	it("treats backslashes as separators", () => {
		expect(projectDirName("C:\\Users\\me\\proj")).toBe("C_3a__Users__me__proj");
	});

	it("drops empty, . and .. segments", () => {
		expect(projectDirName("/home/../home/./proj")).toBe("home__home__proj");
	});

	it("falls back to root when no segment remains", () => {
		expect(projectDirName("/")).toBe("root");
		expect(projectDirName("..")).toBe("root");
	});

	it("truncates long keys to 100 chars plus a hash suffix", () => {
		const key = `github.com/${"a".repeat(40)}/${"b".repeat(120)}`;
		const name = projectDirName(key);
		expect(name.startsWith(`github.com__${"a".repeat(40)}__${"b".repeat(46)}`)).toBe(true);
		expect(name).toMatch(/__[0-9a-f]{8}$/);
		expect(name.length).toBe(110);
	});

	it("is deterministic and distinct for different long keys", () => {
		const a = `github.com/x/${"a".repeat(120)}`;
		const b = `github.com/x/${"a".repeat(119)}b`;
		expect(projectDirName(a)).toBe(projectDirName(a));
		expect(projectDirName(a)).not.toBe(projectDirName(b));
	});
});
