import { type EntryManifest } from "@yandy0725/auto-memory";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_INDEX_SECTION } from "../src/index-source";
import { applyIndexSection, buildInjection, runSideQuery } from "../src/inject-pi";

/**
 * pi 专属的注入**机制**：往 `systemPromptOptions.sections` 里写、往 system prompt 上拼、
 * 以及经 pi 的 headless 会话跑侧查询。
 *
 * 「算出该注入什么字符串」的纯策略钉在 `auto-memory/tests/injection.test.ts`。
 */
const { runHeadlessAgentMock } = vi.hoisted(() => ({
	runHeadlessAgentMock: vi.fn(),
}));
vi.mock("../src/agent-runner", () => ({
	runHeadlessAgent: runHeadlessAgentMock,
}));

function manifest(file: string, over: Partial<EntryManifest> = {}): EntryManifest {
	return {
		file,
		name: file.replace(/\.md$/, ""),
		description: `description of ${file}`,
		type: "feedback",
		modified: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

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

describe("runSideQuery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls runHeadlessAgent with maxTurns=1, timeoutMs=30000, tools=[] and parses selected_files", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce('{"selected_files":["a.md"]}');

		const result = await runSideQuery(
			[manifest("a.md")],
			"how do I debug?",
			new Set(),
			5,
			"off",
			"deepseek/deepseek-v4-flash",
			{} as any,
			"/mem",
		);

		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/mem", thinkLevel: "off", maxTurns: 1, timeoutMs: 30_000, tools: [] }),
		);
		expect(result).toEqual(["a.md"]);
	});

	it("forwards the configured model string", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce('{"selected_files":[]}');
		await runSideQuery(
			[manifest("a.md")],
			"some query",
			new Set(),
			5,
			"off",
			"deepseek/deepseek-v4-flash",
			{} as any,
			"/mem",
		);
		expect(runHeadlessAgentMock.mock.calls[0][0]).toMatchObject({
			model: "deepseek/deepseek-v4-flash",
			tools: [],
		});
	});

	it("drops files that are not in the manifest", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce('{"selected_files":["a.md","evil.md"]}');
		const result = await runSideQuery(
			[manifest("a.md")],
			"q",
			new Set(),
			5,
			"off",
			"deepseek/deepseek-v4-flash",
			{} as any,
			"/mem",
		);
		expect(result).toEqual(["a.md"]);
	});

	it("returns [] on timeout/failure (no fallback)", async () => {
		runHeadlessAgentMock.mockRejectedValueOnce(new Error("timed out"));
		const result = await runSideQuery(
			[manifest("debugging.md")],
			"I need to debug SSH",
			new Set(),
			5,
			"off",
			"deepseek/deepseek-v4-flash",
			{} as any,
			"/mem",
		);
		expect(result).toEqual([]);
	});

	it("returns [] when the response has no valid JSON", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce("not json at all");
		const result = await runSideQuery(
			[manifest("a.md")],
			"some query",
			new Set(),
			5,
			"off",
			"deepseek/deepseek-v4-flash",
			{} as any,
			"/mem",
		);
		expect(result).toEqual([]);
	});

	it("returns [] when no candidates remain", async () => {
		const result = await runSideQuery([], "some prompt", new Set(), 5, "off", "deepseek/deepseek-v4-flash", {} as any, "/mem");
		expect(result).toEqual([]);
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});

	it("filters out already-injected entry files", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce('{"selected_files":["a.md"]}');
		const result = await runSideQuery(
			[manifest("a.md")],
			"some query",
			new Set(["a.md"]),
			5,
			"off",
			"deepseek/deepseek-v4-flash",
			{} as any,
			"/mem",
		);
		expect(result).toEqual([]);
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});
});
