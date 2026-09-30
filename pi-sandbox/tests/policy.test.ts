import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalPath, isSandboxMode, resolveEffectiveMode, SANDBOX_MODES, writableRoots } from "../src/policy";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "policy-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("canonicalPath", () => {
	it("resolves symlinks", () => {
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
	it("workspace-write: canonical, deduped, contains workspace and /tmp", () => {
		const roots = writableRoots("workspace-write", dir);
		expect(roots).toContain(canonicalPath(dir));
		expect(roots).toContain(canonicalPath("/tmp"));
		expect(new Set(roots).size).toBe(roots.length);
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
