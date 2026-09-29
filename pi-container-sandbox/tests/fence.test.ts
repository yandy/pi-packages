import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertWriteAllowed, canonicalizeTarget, FenceDenialError, isWithinRoots } from "../src/fence";

let dir: string;
let ws: string;
let outside: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fence-"));
	// NOTE: 目录先建再 realpath——realpathSync.native 对不存在的路径抛 ENOENT。
	mkdirSync(join(dir, "ws"), { recursive: true });
	mkdirSync(join(dir, "outside"), { recursive: true });
	ws = realpathSync.native(join(dir, "ws"));
	outside = realpathSync.native(join(dir, "outside"));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const wsWrite = { mode: "workspace-write" as const, workspaceRoot: ws };

describe("canonicalizeTarget", () => {
	it("resolves symlinks in the existing prefix, keeps the missing tail", () => {
		symlinkSync(outside, join(ws, "link"));
		expect(canonicalizeTarget(join(ws, "link", "newfile.txt"))).toBe(join(outside, "newfile.txt"));
	});
	it("keeps an entirely missing path's resolved spelling", () => {
		expect(canonicalizeTarget(join(ws, "a", "b"))).toBe(join(ws, "a", "b"));
	});
	it("follows a dangling symlink to its target spelling (Ruling 7)", () => {
		symlinkSync(join(realpathSync.native("/etc"), "sbx-probe-x"), join(ws, "d2"));
		expect(canonicalizeTarget(join(ws, "d2"))).toBe(join(realpathSync.native("/etc"), "sbx-probe-x"));
	});
	it("collapses .. lexically against the real ancestor", () => {
		expect(canonicalizeTarget(join(ws, "sub", "..", "f"))).toBe(join(ws, "f"));
	});
});

describe("isWithinRoots", () => {
	it("lexical fast path: exact root and prefix", () => {
		expect(isWithinRoots(ws, [ws])).toBe(true);
		expect(isWithinRoots(join(ws, "a/b"), [ws])).toBe(true);
		expect(isWithinRoots(`${ws}sibling`, [ws])).toBe(false); // 字符串前缀但非路径段边界
	});
	it("ancestor identity walk catches a symlinked spelling that lexically misses", () => {
		const viaSymlink = join(dir, "ws-link", "f"); // dir/ws-link → ws（词法上不含 ws 前缀）
		symlinkSync(ws, join(dir, "ws-link"));
		expect(isWithinRoots(viaSymlink, [ws])).toBe(true);
	});
	it("unrelated path → false", () => {
		expect(isWithinRoots(join(outside, "f"), [ws])).toBe(false);
	});
});

describe("assertWriteAllowed", () => {
	it("allows inside the workspace, including missing tails", () => {
		expect(() => assertWriteAllowed(join(ws, "new/dir/file.txt"), wsWrite)).not.toThrow();
	});
	it("allows /tmp and os.tmpdir()", () => {
		expect(() => assertWriteAllowed(join(canonicalizeTarget("/tmp"), "sbx-test-x"), wsWrite)).not.toThrow();
		expect(() => assertWriteAllowed(join(canonicalizeTarget(tmpdir()), "sbx-test-x"), wsWrite)).not.toThrow();
	});
	it("denies outside with marker + hint (Review Focus #1: symlink escape)", () => {
		// 逃逸目标必须是真·围栏外的既有目录：dir/outside 落在 os.tmpdir() 下，而 tmpdir()
		// 是 workspace-write 的可写根（spec §4），指过去会被合法放行；计划 Review Focus #1
		// 指定 /etc。尾部故意不存在（计划原文"目标不存在"），否则整条路径可被 realpath 解出。
		symlinkSync(realpathSync.native("/etc"), join(ws, "link"));
		let err: unknown;
		try { assertWriteAllowed(join(ws, "link", "sbx-nonexistent-probe"), wsWrite); } catch (e) { err = e; }
		expect(err).toBeInstanceOf(FenceDenialError);
		const msg = (err as Error).message;
		expect(msg).toContain("[sandbox: file access denied under workspace-write mode]");
		expect(msg).toContain("[sandbox: escalation available — retry this exact operation once");
	});
	it("denies a dangling final-component symlink pointing outside (Ruling 7: P1 escape)", () => {
		symlinkSync(join(realpathSync.native("/etc"), `sbx-dangling-probe-${process.pid}`), join(ws, "dangling"));
		expect(() => assertWriteAllowed(join(ws, "dangling"), wsWrite)).toThrow(FenceDenialError);
	});
	it("allows a dangling final-component symlink pointing inside the workspace", () => {
		symlinkSync(join(ws, "future.txt"), join(ws, "dangling-in"));
		expect(() => assertWriteAllowed(join(ws, "dangling-in"), wsWrite)).not.toThrow();
	});
	it("read-only denies everything, even inside the workspace", () => {
		expect(() => assertWriteAllowed(join(ws, "f"), { mode: "read-only", workspaceRoot: ws })).toThrow(FenceDenialError);
	});
	it("danger-full-access allows anywhere", () => {
		expect(() => assertWriteAllowed("/etc/hosts", { mode: "danger-full-access", workspaceRoot: ws })).not.toThrow();
	});
});
