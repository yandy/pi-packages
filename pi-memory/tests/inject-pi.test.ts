import { describe, expect, it, vi } from "vitest";
import { MEMORY_INDEX_SECTION } from "../src/index-source";
import { applyIndexSection, buildInjection } from "../src/inject-pi";

/**
 * pi 专属的注入**机制**：往 `systemPromptOptions.sections` 里写、往 system prompt 上拼、
 * 以及经 pi 的 headless 会话跑侧查询。
 *
 * 「算出该注入什么字符串」的纯策略钉在 `auto-memory/tests/injection.test.ts`。
 */
describe("applyIndexSection", () => {
	it("writes memory_index into the mutable sections object and returns true", () => {
		const options = { sections: {} as Record<string, string | null> };

		expect(applyIndexSection(options, "- [A](a.md) — d\n")).toBe(true);
		expect(options.sections[MEMORY_INDEX_SECTION]).toBe("- [A](a.md) — d\n");
	});

	// spec §9.1 的 null 陷阱：省略该键 = pi 生成 { memory_index: null } = 删掉整段索引。
	it("writes an empty value instead of omitting the key", () => {
		const options = { sections: { memory_index: "stale" } as Record<string, string | null> };

		expect(applyIndexSection(options, "")).toBe(true);
		expect(options.sections[MEMORY_INDEX_SECTION]).toBe("");
		expect(Object.keys(options.sections)).toEqual([MEMORY_INDEX_SECTION]);
	});

	it("leaves other sections and their order untouched", () => {
		const options = { sections: { preamble: "p", memory_index: "old" } as Record<string, string | null> };

		applyIndexSection(options, "new");

		expect(Object.keys(options.sections)).toEqual(["preamble", "memory_index"]);
		expect(options.sections.preamble).toBe("p");
		expect(options.sections[MEMORY_INDEX_SECTION]).toBe("new");
	});

	it("returns false when the host SDK exposes no sections (0.80.2)", () => {
		expect(applyIndexSection({}, "v")).toBe(false);
		expect(applyIndexSection(undefined, "v")).toBe(false);
		expect(applyIndexSection(null, "v")).toBe(false);
		expect(applyIndexSection({ sections: null }, "v")).toBe(false);
		expect(applyIndexSection({ sections: "nope" }, "v")).toBe(false);
	});
});

describe("buildInjection", () => {
	it("appends snapshot to system prompt", () => {
		expect(buildInjection("BASE PROMPT", "# Memory Index\n- [A](a.md) — desc")).toBe(
			"BASE PROMPT\n\n# Memory Index\n- [A](a.md) — desc",
		);
	});

	it("returns base unchanged when snapshot is empty", () => {
		expect(buildInjection("BASE", "")).toBe("BASE");
	});
});
