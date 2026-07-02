import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { projectHash, resolveMemoryDir, safeTopicPath } from "../src/paths";

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
