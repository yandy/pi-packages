import { beforeEach, describe, expect, it, vi } from "vitest";
import { type EntryManifest, type HeadlessRunRequest, runSideQuery } from "../src/index.js";

/**
 * 侧查询的编排。
 *
 * 被测的是 core 的决策：候选过滤、prompt 构造、请求字段、以及对宿主回复的解析与失败兜底。
 * 宿主怎么跑那一轮（pi 的 `createAgentSession`、别家的 subagent）由适配层的假端口代替。
 */
const headlessRun = vi.fn();
const ports = { headless: { run: headlessRun } };

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

const base = {
	maxFiles: 5,
	effort: "off",
	model: "deepseek/deepseek-v4-flash",
	cwd: "/mem",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("runSideQuery", () => {
	it("asks the host for one turn, no tools, a 30s timeout, and parses selected_files", async () => {
		headlessRun.mockResolvedValueOnce('{"selected_files":["a.md"]}');

		const result = await runSideQuery(
			{ ...base, manifest: [manifest("a.md")], userPrompt: "how do I debug?", injectedFiles: new Set() },
			ports,
		);

		expect(headlessRun).toHaveBeenCalledTimes(1);
		const req: HeadlessRunRequest = headlessRun.mock.calls[0][0];
		expect(req).toMatchObject({
			cwd: "/mem",
			effort: "off",
			maxTurns: 1,
			timeoutMs: 30_000,
			builtinTools: "none",
			memoryTool: null,
		});
		expect(result).toEqual(["a.md"]);
	});

	it("forwards the configured model string", async () => {
		headlessRun.mockResolvedValueOnce('{"selected_files":[]}');
		await runSideQuery({ ...base, manifest: [manifest("a.md")], userPrompt: "some query", injectedFiles: new Set() }, ports);
		expect(headlessRun.mock.calls[0][0]).toMatchObject({ model: "deepseek/deepseek-v4-flash" });
	});

	it("drops files that are not in the manifest", async () => {
		headlessRun.mockResolvedValueOnce('{"selected_files":["a.md","evil.md"]}');
		const result = await runSideQuery(
			{ ...base, manifest: [manifest("a.md")], userPrompt: "q", injectedFiles: new Set() },
			ports,
		);
		expect(result).toEqual(["a.md"]);
	});

	it("returns [] on timeout/failure (no fallback)", async () => {
		headlessRun.mockRejectedValueOnce(new Error("timed out"));
		const result = await runSideQuery(
			{ ...base, manifest: [manifest("debugging.md")], userPrompt: "I need to debug SSH", injectedFiles: new Set() },
			ports,
		);
		expect(result).toEqual([]);
	});

	// 端口的 `null` 语义是「宿主没跑这一轮」，与「跑了但没选出来」必须一样安全：
	// auto-surfacing 是纯增益，任何一条路径都不得打断用户这一轮。
	it("returns [] when the host declines to run the round", async () => {
		headlessRun.mockResolvedValueOnce(null);
		const result = await runSideQuery(
			{ ...base, manifest: [manifest("a.md")], userPrompt: "q", injectedFiles: new Set() },
			ports,
		);
		expect(result).toEqual([]);
	});

	it("returns [] when the response has no valid JSON", async () => {
		headlessRun.mockResolvedValueOnce("not json at all");
		const result = await runSideQuery(
			{ ...base, manifest: [manifest("a.md")], userPrompt: "some query", injectedFiles: new Set() },
			ports,
		);
		expect(result).toEqual([]);
	});

	it("returns [] when no candidates remain", async () => {
		const result = await runSideQuery(
			{ ...base, manifest: [], userPrompt: "some prompt", injectedFiles: new Set() },
			ports,
		);
		expect(result).toEqual([]);
		expect(headlessRun).not.toHaveBeenCalled();
	});

	it("filters out already-injected entry files", async () => {
		headlessRun.mockResolvedValueOnce('{"selected_files":["a.md"]}');
		const result = await runSideQuery(
			{ ...base, manifest: [manifest("a.md"), manifest("b.md")], userPrompt: "q", injectedFiles: new Set(["b.md"]) },
			ports,
		);
		// 候选清单里不含 b.md，所以宿主即使选了它也会被丢掉
		expect(headlessRun.mock.calls[0][0].task).toContain("a.md");
		expect(headlessRun.mock.calls[0][0].task).not.toContain("b.md");
		expect(result).toEqual(["a.md"]);
	});

	it("never asks the host when every candidate was already injected", async () => {
		const result = await runSideQuery(
			{ ...base, manifest: [manifest("a.md")], userPrompt: "q", injectedFiles: new Set(["a.md"]) },
			ports,
		);
		expect(result).toEqual([]);
		expect(headlessRun).not.toHaveBeenCalled();
	});
});
