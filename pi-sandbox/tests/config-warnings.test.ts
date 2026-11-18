import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	markProcessHasUI,
	processHasUI,
	reportConfigWarning,
	resetConfigWarningStateForTests,
	setConfigWarningSink,
	takeConfigWarnings,
} from "../src/config-warnings";

/**
 * 配置告警出口的语义（spec 2026-11-18）：factory 顶部读配置时没有 ctx，告警必须先入缓冲，
 * 等 session_start 安装出口再补发。这里的用例钉住缓冲/补发/摘除/出口抛错四条行为。
 */
beforeEach(() => {
	resetConfigWarningStateForTests();
});
afterEach(() => {
	resetConfigWarningStateForTests();
});

describe("config warnings sink", () => {
	it("没有出口时入缓冲：加载期不往终端写字（正对照：toggle 后才会直发）", () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const rawWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			reportConfigWarning("sandbox: boom");
			expect(takeConfigWarnings()).toEqual(["sandbox: boom"]);
			expect(rawWarn).not.toHaveBeenCalled();
			expect(write).not.toHaveBeenCalled();
		} finally {
			rawWarn.mockRestore();
			write.mockRestore();
		}
	});

	it("安装出口时先补发缓冲，之后直发（顺序保持）", () => {
		reportConfigWarning("first");
		reportConfigWarning("second");
		const seen: string[] = [];
		setConfigWarningSink((message) => seen.push(message));
		expect(seen).toEqual(["first", "second"]);
		reportConfigWarning("third");
		expect(seen).toEqual(["first", "second", "third"]);
		expect(takeConfigWarnings()).toEqual([]); // 补发时已清空，不会重复发
	});

	it("摘除出口（session_shutdown）后新告警重新入缓冲，不再发往旧出口", () => {
		const seen: string[] = [];
		setConfigWarningSink((message) => seen.push(message));
		setConfigWarningSink(null);
		reportConfigWarning("after shutdown");
		expect(seen).toEqual([]);
		expect(takeConfigWarnings()).toEqual(["after shutdown"]);
	});

	it("出口抛错（陈旧 ctx）不炸加载路径，告警退回缓冲", () => {
		let calls = 0;
		setConfigWarningSink(() => {
			calls += 1;
			throw new Error("This extension ctx is stale after session replacement or reload.");
		});
		expect(() => reportConfigWarning("warn me")).not.toThrow();
		expect(calls).toBe(1);
		expect(takeConfigWarnings()).toEqual(["warn me"]);
	});

	it("补发时出口逐条抛错：失败的留下、成功的发走", () => {
		reportConfigWarning("ok-1");
		reportConfigWarning("bad");
		reportConfigWarning("ok-2");
		const seen: string[] = [];
		setConfigWarningSink((message) => {
			if (message === "bad") throw new Error("nope");
			seen.push(message);
		});
		expect(seen).toEqual(["ok-1", "ok-2"]);
		expect(takeConfigWarnings()).toEqual(["bad"]);
	});

	it("进程级 UI 标志跨模块实例共享（挂 globalThis，reload / 子会话重新 import 后仍可见）", () => {
		expect(processHasUI()).toBe(false); // 正对照
		markProcessHasUI();
		expect(processHasUI()).toBe(true);
		expect((globalThis as Record<symbol, unknown>)[Symbol.for("@yandy0725/pi-sandbox:ui-seen")]).toBe(true);
	});
});
