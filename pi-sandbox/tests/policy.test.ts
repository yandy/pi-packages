import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalPath, canonicalRoots, defaultTmpRoots, isSandboxMode, resolveEffectiveMode, SANDBOX_MODES, writableRoots } from "../src/policy";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "policy-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("canonicalPath", () => {
	// win32 跳过：建 symlink 需特权（开发者模式/管理员）；Windows 侧链接/junction 解析由 tests/win32/e2e.test.ts 覆盖。
	it.skipIf(process.platform === "win32")("resolves symlinks", () => {
		writeFileSync(join(dir, "real"), "x");
		symlinkSync(join(dir, "real"), join(dir, "link"));
		expect(canonicalPath(join(dir, "link"))).toBe(canonicalPath(join(dir, "real")));
	});
	it("keeps the spelling of a missing path", () => {
		const missing = join(dir, "nope");
		expect(canonicalPath(missing)).toBe(missing);
	});
});

describe("writableRoots", () => {
	it("is empty for read-only and danger-full-access", () => {
		expect(writableRoots("read-only", dir)).toEqual([]);
		expect(writableRoots("danger-full-access", dir)).toEqual([]);
	});
	it("workspace-write: canonical, deduped, contains workspace and the platform tmp roots", () => {
		const roots = writableRoots("workspace-write", dir);
		expect(roots).toContain(canonicalPath(dir));
		// 平台无关：缺省 tmp 根由 defaultTmpRoots(platform) 推导（POSIX 为 "/tmp" + os.tmpdir()，win32 只有 %TEMP%）。
		for (const tmp of defaultTmpRoots(process.platform)) expect(roots).toContain(canonicalPath(tmp));
		expect(new Set(roots).size).toBe(roots.length);
	});
	it("workspace-write appends extra roots, canonical and deduped", () => {
		const extra = mkdtempSync(join(tmpdir(), "policy-extra-"));
		try {
			const roots = writableRoots("workspace-write", dir, defaultTmpRoots(), [extra, extra, dir]);
			expect(roots).toContain(canonicalPath(extra));
			expect(new Set(roots).size).toBe(roots.length);
		} finally { rmSync(extra, { recursive: true, force: true }); }
	});
	it("read-only and danger-full-access ignore extra roots", () => {
		expect(writableRoots("read-only", dir, defaultTmpRoots(), [dir])).toEqual([]);
		expect(writableRoots("danger-full-access", dir, defaultTmpRoots(), [dir])).toEqual([]);
	});
	describe("canonicalRoots", () => {
		it("canonicalizes, dedupes, preserves order, keeps missing paths as spelled", () => {
			expect(canonicalRoots([join(dir, "a"), join(dir, "a"), join(dir, "missing")]))
				.toEqual([canonicalPath(join(dir, "a")), join(dir, "missing")]);
		});
		it.skipIf(process.platform === "win32")("folds a symlink onto its target", () => {
			mkdirSync(join(dir, "real"));
			symlinkSync(join(dir, "real"), join(dir, "link"));
			expect(canonicalRoots([join(dir, "link")])).toEqual([canonicalPath(join(dir, "real"))]);
		});
	});
});

describe("isSandboxMode", () => {
	it("accepts exactly the three modes", () => {
		for (const m of SANDBOX_MODES) expect(isSandboxMode(m)).toBe(true);
		expect(isSandboxMode("nope")).toBe(false);
		expect(isSandboxMode(undefined)).toBe(false);
	});
});

describe("resolveEffectiveMode", () => {
	it("override outranks config default", () => {
		expect(resolveEffectiveMode("read-only", "workspace-write")).toBe("read-only");
		expect(resolveEffectiveMode(null, "workspace-write")).toBe("workspace-write");
	});
});

describe("win32 writable roots", () => {
	it("drops the POSIX /tmp root on Windows", () => {
		expect(defaultTmpRoots("win32")).toEqual([tmpdir()]);
		expect(defaultTmpRoots("linux")).toEqual(["/tmp", tmpdir()]);
		expect(defaultTmpRoots("darwin")).toEqual(["/tmp", tmpdir()]);
	});

	it("derives the win32 workspace-write roots (workspace + %TEMP%)", () => {
		const roots = writableRoots("workspace-write", "C:\\ws", defaultTmpRoots("win32"));
		expect(roots).toHaveLength(2);
		expect(roots.map((r) => r.toLowerCase())).toContain("c:\\ws".toLowerCase());
	});
});
