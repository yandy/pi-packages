import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultMemoryRoot } from "../src/config.js";

/**
 * 共享数据根（spec D3 / §5.2）。
 *
 * 这个函数是「跨 harness 共享同一份记忆」的地基：pi 与任何其他宿主都必须独立算出**同一个**
 * 目录，所以规则里不能有任何宿主名，也不能有任何平台分支 —— 所有平台走同一条 XDG 规则。
 */
describe("defaultMemoryRoot", () => {
	it("uses XDG_DATA_HOME when it is an absolute path", () => {
		expect(defaultMemoryRoot({ XDG_DATA_HOME: "/data" }, "/home/u")).toBe(join("/data", "auto-memory"));
	});

	it("falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
		expect(defaultMemoryRoot({}, "/home/u")).toBe(join("/home/u", ".local", "share", "auto-memory"));
	});

	// Review Focus #1：相对根会让「哪个项目用哪个目录」取决于 cwd，共享就失效了。
	it("ignores a relative XDG_DATA_HOME", () => {
		expect(defaultMemoryRoot({ XDG_DATA_HOME: "data" }, "/home/u")).toBe(
			join("/home/u", ".local", "share", "auto-memory"),
		);
		expect(defaultMemoryRoot({ XDG_DATA_HOME: "../data" }, "/home/u")).toBe(
			join("/home/u", ".local", "share", "auto-memory"),
		);
	});

	it("ignores an empty or whitespace-only XDG_DATA_HOME", () => {
		for (const value of ["", "   ", "\t"]) {
			expect(defaultMemoryRoot({ XDG_DATA_HOME: value }, "/home/u")).toBe(
				join("/home/u", ".local", "share", "auto-memory"),
			);
		}
	});

	it("trims surrounding whitespace of a valid XDG_DATA_HOME", () => {
		expect(defaultMemoryRoot({ XDG_DATA_HOME: "  /data  " }, "/home/u")).toBe(join("/data", "auto-memory"));
	});

	it("is platform-independent: a Windows home gets the same rule", () => {
		// 规则里没有平台分支：home 是什么形状，就在它下面拼 `.local/share/auto-memory`。
		// 注意 `isAbsolute` 用的是运行平台的语义，所以「Windows 风格的 XDG_DATA_HOME」在 POSIX 上
		// 不算绝对路径、会回落 —— 这是刻意的（spec §5.2：不加平台分支），不在此钉。
		expect(defaultMemoryRoot({}, "C:\\Users\\u")).toBe(join("C:\\Users\\u", ".local", "share", "auto-memory"));
	});

	it("defaults to the real environment and home directory", () => {
		const xdg = process.env.XDG_DATA_HOME?.trim();
		const expected =
			xdg && isAbsolute(xdg) ? join(xdg, "auto-memory") : join(homedir(), ".local", "share", "auto-memory");
		expect(defaultMemoryRoot()).toBe(expected);
	});
});
