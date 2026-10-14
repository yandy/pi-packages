import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { carveOutRoots, protectedRoots, shellProtectionNote } from "../src/protected";

/**
 * spec 2026-10-14-protected-project-config：受保护根与「runner 侧按存在性门控」的分工。
 * 围栏侧无条件保护（含不存在的路径），runner 侧只挖已存在的洞——两者的差异是设计，不是疏漏。
 */

let ws: string;
beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "protect-"));
});
afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
});

describe("protectedRoots", () => {
	it("names the host's config dir under the workspace, not a hardcoded .pi", () => {
		expect(protectedRoots(ws)).toEqual([join(ws, CONFIG_DIR_NAME)]);
	});

	it("is existence-independent: the fence must also block creating it from scratch", () => {
		// 「从零创建 .pi/agents/x.md」是这条漏洞最主要的攻击形状，所以路径层面必须无条件受保护。
		expect(protectedRoots(ws)).toHaveLength(1);
		expect(carveOutRoots(ws)).toEqual([]); // 但 runner 侧还挖不了（目录不存在）
	});

	it("follows an injected config dir name", () => {
		expect(protectedRoots(ws, { configDirName: ".agent" })).toEqual([join(ws, ".agent")]);
	});

	it("refuses to build a malformed root from a bogus config dir name", () => {
		// 空串会 join 出工作区自身（整个工作区变只读），带分隔符会 join 出工作区外的路径——
		// 两种都返回空列表：宁可不保护，也不能保护到错误的范围。
		expect(protectedRoots(ws, { configDirName: "" })).toEqual([]);
		expect(protectedRoots(ws, { configDirName: "../etc" })).toEqual([]);
		expect(protectedRoots(ws, { configDirName: "a/b" })).toEqual([]);
		expect(protectedRoots(ws, { configDirName: "a\\b" })).toEqual([]);
	});
});

describe("carveOutRoots", () => {
	it("is empty while the protected dir does not exist", () => {
		expect(carveOutRoots(ws)).toEqual([]);
	});

	it("includes the protected dir once it exists", () => {
		mkdirSync(join(ws, CONFIG_DIR_NAME), { recursive: true });
		expect(carveOutRoots(ws)).toEqual([join(ws, CONFIG_DIR_NAME)]);
	});

	it("honors an injected exists()", () => {
		expect(carveOutRoots(ws, { exists: () => true })).toEqual([join(ws, CONFIG_DIR_NAME)]);
		expect(carveOutRoots(ws, { exists: () => false })).toEqual([]);
	});

	it("carves nothing when the config dir name is bogus", () => {
		expect(carveOutRoots(ws, { configDirName: "", exists: () => true })).toEqual([]);
	});
});

/**
 * `shellProtectionNote` 的五个分支必须直接钉住，不能只经 /permission 状态行间接覆盖：
 * 状态行走真实 selectRunner，在一台装了 bwrap 的机器上只会命中 bwrap 分支，
 * landlock / seatbelt / windows-acl / unavailable 四条全是死区——而那正是「明明没挡住却报 protected」
 * 这类假信号最容易藏身的地方。
 */
describe("shellProtectionNote", () => {
	const exists = (yes: boolean) => ({ exists: () => yes });

	it("bwrap: protected once the config dir exists", () => {
		expect(shellProtectionNote("bwrap", false, ws, exists(true)))
			.toBe("confined shell: protected (read-only bind)");
	});

	it("bwrap: NOT protected yet when it does not exist, and says why", () => {
		const note = shellProtectionNote("bwrap", false, ws, exists(false));
		expect(note).toContain("confined shell: NOT protected yet");
		expect(note).toContain(join(ws, CONFIG_DIR_NAME));
		expect(note).toContain("does not exist");
		expect(note).toContain("bwrap cannot ro-bind a missing path");
	});

	it("a custom runnerCommand is held to the bwrap contract, existence gate included", () => {
		expect(shellProtectionNote(null, true, ws, exists(true)))
			.toBe("confined shell: protected (read-only bind)");
		expect(shellProtectionNote(null, true, ws, exists(false))).toContain("NOT protected yet");
	});

	it("seatbelt: protected regardless of existence (its deny covers creating the dir)", () => {
		expect(shellProtectionNote("seatbelt", false, ws, exists(false)))
			.toBe("confined shell: protected (seatbelt deny)");
	});

	it("landlock: NOT protected, names the union semantics and the fix", () => {
		const note = shellProtectionNote("landlock", false, ws, exists(true));
		expect(note).toContain("confined shell: NOT protected");
		expect(note).toContain("union");
		expect(note).toContain("install bwrap to close this");
	});

	it("windows-acl: NOT protected, says the runner has no carve-out", () => {
		expect(shellProtectionNote("windows-acl", false, ws, exists(true)))
			.toContain("the windows-acl runner does not implement a carve-out yet");
	});

	it("no runner in play: not applicable, never 'protected'", () => {
		const note = shellProtectionNote(null, false, ws, exists(true));
		expect(note).toBe("confined shell: not applicable (no runner in play)");
		expect(note).not.toContain("protected (");
	});
});
