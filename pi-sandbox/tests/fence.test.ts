import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertWriteAllowed, canonicalizeTarget, FenceDenialError, isWithinRoots } from "../src/fence";
import { escalationHintMarker } from "../src/escalation";
import { defaultTmpRoots } from "../src/policy";

/**
 * Windows 上创建符号链接需要特权（开发者模式或管理员），且 junction / 8.3 短名 / 大小写不敏感
 * 的解析语义与 POSIX 不同，故依赖 `symlinkSync` 的 POSIX 语义用例在 win32 上跳过；Windows 侧的
 * 链接 / 短名 / 大小写覆盖在 `tests/win32/e2e.test.ts` 与本文件「win32 containment」里 win32 门控的注入用例。
 */
const isWin32 = process.platform === "win32";

let dir: string;
let ws: string;
let outside: string;
// 注意：wsWrite 必须在 beforeEach 里构造——模块层构造会固化当时的 ws（undefined），
// 旧实现用 statSync 的 try/catch 静默吞掉 undefined 根，掩盖了这几条测试从未跑过工作区根。
let wsWrite: { mode: "workspace-write"; workspaceRoot: string };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fence-"));
	// NOTE: 目录先建再 realpath——realpathSync.native 对不存在的路径抛 ENOENT。
	mkdirSync(join(dir, "ws"), { recursive: true });
	mkdirSync(join(dir, "outside"), { recursive: true });
	ws = realpathSync.native(join(dir, "ws"));
	outside = realpathSync.native(join(dir, "outside"));
	wsWrite = { mode: "workspace-write", workspaceRoot: ws };
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("canonicalizeTarget", () => {
	// win32 跳过：建 symlink 需特权（开发者模式/管理员）；Windows 侧链接语义由 tests/win32/e2e.test.ts 覆盖。
	it.skipIf(isWin32)("resolves symlinks in the existing prefix, keeps the missing tail", () => {
		symlinkSync(outside, join(ws, "link"));
		expect(canonicalizeTarget(join(ws, "link", "newfile.txt"))).toBe(join(outside, "newfile.txt"));
	});
	it("keeps an entirely missing path's resolved spelling", () => {
		expect(canonicalizeTarget(join(ws, "a", "b"))).toBe(join(ws, "a", "b"));
	});
	// win32 跳过：建 symlink 需特权（开发者模式/管理员）；Windows 侧链接语义由 tests/win32/e2e.test.ts 覆盖。
	it.skipIf(isWin32)("follows a dangling symlink to its target spelling (Ruling 7)", () => {
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
	// win32 跳过：建 symlink 需特权（开发者模式/管理员）；Windows 侧祖先身份/短名语义由 tests/win32/e2e.test.ts 覆盖。
	it.skipIf(isWin32)("ancestor identity walk catches a symlinked spelling that lexically misses", () => {
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
	it("allows every platform tmp root (defaultTmpRoots) and os.tmpdir()", () => {
		// 平台无关：不写字面 "/tmp"——win32 的 tmp 可写根只有 os.tmpdir()（%TEMP%），字面 "/tmp" 在那里
		// 应当被拒绝（这正是本用例在 Windows 上曾失败的原因）。缺省 tmp 根由 defaultTmpRoots(platform) 推导。
		for (const root of defaultTmpRoots(process.platform)) {
			expect(() => assertWriteAllowed(join(canonicalizeTarget(root), "sbx-test-x"), wsWrite)).not.toThrow();
		}
		expect(() => assertWriteAllowed(join(canonicalizeTarget(tmpdir()), "sbx-test-x"), wsWrite)).not.toThrow();
	});
	// win32 跳过：建 symlink 需特权（开发者模式/管理员）；Windows 侧围栏逃逸由 tests/win32/e2e.test.ts 覆盖。
	it.skipIf(isWin32)("denies outside with marker + hint (Review Focus #1: symlink escape)", () => {
		// 逃逸目标必须是真·围栏外的既有目录：dir/outside 落在 os.tmpdir() 下，而 tmpdir()
		// 是 workspace-write 的可写根（spec §4），指过去会被合法放行；计划 Review Focus #1
		// 指定 /etc。尾部故意不存在（计划原文"目标不存在"），否则整条路径可被 realpath 解出。
		symlinkSync(realpathSync.native("/etc"), join(ws, "link"));
		let err: unknown;
		try { assertWriteAllowed(join(ws, "link", "sbx-nonexistent-probe"), wsWrite); } catch (e) { err = e; }
		expect(err).toBeInstanceOf(FenceDenialError);
		const msg = (err as Error).message;
		expect(msg).toContain("[sandbox: file access denied under workspace-write mode]");
		expect(msg).toContain(escalationHintMarker("operation"));
	});
	// win32 跳过：建 symlink 需特权（开发者模式/管理员）；Windows 侧围栏逃逸由 tests/win32/e2e.test.ts 覆盖。
	it.skipIf(isWin32)("denies a dangling final-component symlink pointing outside (Ruling 7: P1 escape)", () => {
		symlinkSync(join(realpathSync.native("/etc"), `sbx-dangling-probe-${process.pid}`), join(ws, "dangling"));
		expect(() => assertWriteAllowed(join(ws, "dangling"), wsWrite)).toThrow(FenceDenialError);
	});
	// win32 跳过：建 symlink 需特权（开发者模式/管理员）；Windows 侧相对链接解析由 tests/win32/e2e.test.ts 覆盖。
	it.skipIf(isWin32)("resolves a relative dangling symlink against the link's directory and denies escape (M5)", () => {
		const etcTarget = join(realpathSync.native("/etc"), `sbx-rel-probe-${process.pid}`);
		symlinkSync(relative(ws, etcTarget), join(ws, "rel-dangling"));
		expect(canonicalizeTarget(join(ws, "rel-dangling"))).toBe(etcTarget);
		expect(() => assertWriteAllowed(join(ws, "rel-dangling"), wsWrite)).toThrow(FenceDenialError);
	});
	// win32 跳过：建 symlink 需特权（开发者模式/管理员）；Windows 侧链接语义由 tests/win32/e2e.test.ts 覆盖。
	it.skipIf(isWin32)("allows a dangling final-component symlink pointing inside the workspace", () => {
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

describe("win32 containment", () => {
	// win32 字面 fixture 一律用真机上不会存在的 C:\__pi_sandbox_fixture__…：若 C:\work\demo
	// 真存在，dev/ino 身份回退会命中仅大小写不同的拼写，case-sensitive 断言会假性失败。
	// 宿主形状路径：分隔符与大小写比较都按宿主 path.sep 走。不能在 POSIX 上用 "C:\..."
	// 字面路径做正例——"\" 在 POSIX 是合法文件名字符，把它当分隔符会让 /tmp/ws\..
	// 这类真实目录被误判成 /tmp/ws 的子路径（真逃逸）；Windows 形状的等价断言见
	// 下面 win32-only 用例。根取不存在的大小写翻转拼写，身份回退无命中，结果确定。
	let caseRoot: string;
	let caseUnder: string;
	beforeEach(() => {
		caseRoot = join(dir, "Case", "Demo");
		caseUnder = join(dir, "case", "demo", "a.txt");
	});

	it("matches case-insensitively when the platform is case-insensitive", () => {
		expect(isWithinRoots(caseUnder, [caseRoot], false)).toBe(true);
		expect(isWithinRoots(join(dir, "case", "other", "a.txt"), [caseRoot], false)).toBe(false);
	});

	it("stays case-sensitive when told to", () => {
		expect(isWithinRoots("C:\\__pi_sandbox_fixture__\\Demo\\a.txt", ["C:\\__pi_sandbox_fixture__\\demo"], true)).toBe(false);
		expect(isWithinRoots(caseUnder, [caseRoot], true)).toBe(false);
	});

	it.skipIf(sep === "\\")("keeps a trailing backslash literal on POSIX (no separator widening)", () => {
		// "\" 在 POSIX 是文件名字符：根 ".../Demo\" 只包含 ".../Demo\/…"，不能因去尾
		// 而把 ".../Demo" 整棵子树也纳入（那是 POSIX 行为的扩大）。
		const weirdRoot = `${caseRoot}\\`;
		expect(isWithinRoots(join(weirdRoot, "f.txt"), [weirdRoot], false)).toBe(true);
		expect(isWithinRoots(join(caseRoot, "f.txt"), [weirdRoot], false)).toBe(false);
	});

	it("uses the platform separator instead of a hardcoded slash", () => {
		expect(isWithinRoots("C:\\__pi_sandbox_fixture__\\demo", ["C:\\__pi_sandbox_fixture__\\demo"], false)).toBe(true);
		expect(isWithinRoots("C:\\__pi_sandbox_fixture__\\demo2", ["C:\\__pi_sandbox_fixture__\\demo"], false)).toBe(false); // 前缀但不是子路径
		expect(isWithinRoots(caseRoot, [caseRoot], false)).toBe(true);
		expect(isWithinRoots(`${caseRoot}2`, [caseRoot], false)).toBe(false); // 前缀但不是子路径
		expect(isWithinRoots(join(caseRoot, "sub", "f.txt"), [caseRoot], false)).toBe(true);
	});

	it("does not treat a bare drive letter as a drive root", () => {
		// 裸 "C:" 是"每驱动器当前目录"（drive-relative），不是盘根 "C:\"：词法包含要求盘符后紧跟分隔符。
		// 该结果与 path.sep 无关（POSIX 上根不存在、词法与身份回退都无命中），故不 gated，Linux 也执行；
		// 正例（"C:\…" 落在 "C:\" 下）只在 win32 成立，放在下面的 win32-gated 用例里。
		// 实现经 DRIVE_RELATIVE_PATH guard 保证该结果在 win32 宿主上也确定（不再依赖 per-drive CWD）。
		expect(isWithinRoots("C:", ["C:\\"], false)).toBe(false);
	});

	it.skipIf(process.platform !== "win32")("normalizes / to \\ and bounds on the platform separator (win32)", () => {
		expect(isWithinRoots("C:\\__pi_sandbox_fixture__\\Demo\\a.txt", ["C:\\__pi_sandbox_fixture__\\demo"], false)).toBe(true);
		expect(isWithinRoots("C:/__pi_sandbox_fixture__/Demo/a.txt", ["C:\\__pi_sandbox_fixture__\\demo"], false)).toBe(true);
		expect(isWithinRoots("C:\\__pi_sandbox_fixture__\\demo2", ["C:\\__pi_sandbox_fixture__\\demo"], false)).toBe(false);
		expect(isWithinRoots("C:\\__pi_sandbox_fixture__\\demo", ["C:\\"], false)).toBe(true); // 盘根：去尾成 "C:" 后由分隔符继续
		expect(isWithinRoots("C:work", ["C:\\"], false)).toBe(false); // 盘相对路径不是盘根子路径
	});

	it("honours the injected case sensitivity in the fence policy", () => {
		// 偏差：计划原稿用字面 "C:\..." 路径，但 Linux 上 canonicalizeTarget 会把它们按
		// POSIX 相对路径拼到 cwd 下（必然拒绝）；且 dir/outside 落在 tmpdir() 这个可写根下，
		// deny 用例需 _tmpRoots: [] 才是真·围栏外。改用真实目录 + 仅大小写不同的根拼写，
		// 覆盖同一条注入链路（canonicalizeTarget → writableRoots → isWithinRoots）。
		const caseFlippedWs = ws.toUpperCase();
		expect(caseFlippedWs).not.toBe(ws); // mkdtemp 前缀 "fence-" 保证大小写翻转后拼写必变
		const policy = {
			mode: "workspace-write" as const,
			workspaceRoot: caseFlippedWs,
			caseSensitive: false,
			_tmpRoots: [] as readonly string[],
		};
		expect(() => assertWriteAllowed(join(ws, "file.txt"), policy)).not.toThrow();
		expect(() => assertWriteAllowed(join(outside, "file.txt"), policy)).toThrowError(/file access denied/);
	});
});
