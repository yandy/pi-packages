import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { carveOutRoots, protectedRoots } from "../src/protected";

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
