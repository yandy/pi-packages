import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadIndexSnapshot, buildInjection, scanTopics, injectSurfacedContent, runSideQuery } from "../src/inject";

const { runHeadlessAgentMock } = vi.hoisted(() => ({
	runHeadlessAgentMock: vi.fn(),
}));
vi.mock("../src/agent-runner", () => ({
	runHeadlessAgent: runHeadlessAgentMock,
}));

describe("loadIndexSnapshot", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-inj-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("returns empty string when MEMORY.md missing", async () => {
		expect(await loadIndexSnapshot(dir, 200, 25600)).toBe("");
	});
	it("returns truncated content when MEMORY.md exists", async () => {
		const content = "- [A](a.md) — desc a\n- [B](b.md) — desc b";
		await writeFile(join(dir, "MEMORY.md"), content);
		const snap = await loadIndexSnapshot(dir, 200, 25600);
		expect(snap).toContain("# Memory Index");
		expect(snap).toContain("- [A](a.md)");
	});
	it("truncates to limits", async () => {
		const many = Array.from({ length: 10 }, (_, i) => `- [T${i}](t${i}.md) — d${i}`).join("\n");
		await writeFile(join(dir, "MEMORY.md"), many);
		const snap = await loadIndexSnapshot(dir, 3, 25600);
		expect(snap).toContain("[truncated:");
	});
});

describe("buildInjection", () => {
	it("appends snapshot to system prompt", () => {
		const out = buildInjection("BASE PROMPT", "# Memory Index\n- [A](a.md) — desc");
		expect(out).toBe("BASE PROMPT\n\n# Memory Index\n- [A](a.md) — desc");
	});
	it("returns base unchanged when snapshot is empty", () => {
		expect(buildInjection("BASE", "")).toBe("BASE");
	});
});

describe("scanTopics", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "surf-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("scans topic files and extracts manifests", async () => {
		await writeFile(join(dir, "a.md"), [
			"---",
			"name: Alpha",
			"description: first topic",
			"type: feedback",
			"updated: 2026-07-03",
			"---",
			"",
			"## Entry",
			"content",
		].join("\n"));
		await writeFile(join(dir, "MEMORY.md"), "dummy");
		const topics = await scanTopics(dir);
		expect(topics).toHaveLength(1);
		expect(topics[0]).toMatchObject({
			filename: "a.md",
			name: "Alpha",
			description: "first topic",
			type: "feedback",
		});
	});

	it("skips MEMORY.md and non-md files", async () => {
		await writeFile(join(dir, "MEMORY.md"), "dummy");
		await writeFile(join(dir, "not-md.txt"), "text");
		const topics = await scanTopics(dir);
		expect(topics).toHaveLength(0);
	});

	it("handles files without valid frontmatter gracefully", async () => {
		await writeFile(join(dir, "bad.md"), "just text");
		const topics = await scanTopics(dir);
		expect(topics).toHaveLength(0);
	});
});

describe("runSideQuery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls runHeadlessAgent with maxTurns=1, timeoutMs=30000, thinkLevel, and parses selected_files", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce('{"selected_files":["a.md"]}');
		const manifest = [
			{ filename: "a.md", name: "A", description: "desc", type: "feedback" as const, mtimeMs: 100 },
		];
		const result = await runSideQuery(
			manifest, "how do I debug?", new Set(), 5, "off",
			undefined, {} as any, {} as any, "/mem",
		);
		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/mem",
				thinkLevel: "off",
				maxTurns: 1,
				timeoutMs: 30_000,
				tools: [],
			}),
		);
		expect(result).toEqual(["a.md"]);
	});

	it("forwards configured model string", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce('{"selected_files":[]}');
		const manifest = [
			{ filename: "a.md", name: "A", description: "desc", type: "feedback" as const, mtimeMs: 100 },
		];
		await runSideQuery(
			manifest, "some query", new Set(), 5, "off",
			"deepseek/deepseek-v4-flash", {} as any, {} as any, "/mem",
		);
		expect(runHeadlessAgentMock.mock.calls[0][0]).toMatchObject({
			model: "deepseek/deepseek-v4-flash",
			tools: [],
		});
	});

	it("returns [] on timeout/failure (no fallback)", async () => {
		runHeadlessAgentMock.mockRejectedValueOnce(new Error("timed out"));
		const manifest = [
			{ filename: "debugging.md", name: "D", description: "SSH tips", type: "project" as const, mtimeMs: 100 },
		];
		const result = await runSideQuery(
			manifest, "I need to debug SSH", new Set(), 5, "off",
			undefined, {} as any, {} as any, "/mem",
		);
		expect(result).toEqual([]);
	});

	it("returns [] when response has no valid JSON", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce("not json at all");
		const manifest = [
			{ filename: "a.md", name: "A", description: "desc", type: "feedback" as const, mtimeMs: 100 },
		];
		const result = await runSideQuery(
			manifest, "some query", new Set(), 5, "off",
			undefined, {} as any, {} as any, "/mem",
		);
		expect(result).toEqual([]);
	});

	it("returns [] when no candidates remain", async () => {
		const result = await runSideQuery(
			[], "some prompt", new Set(), 5, "off",
			undefined, {} as any, {} as any, "/mem",
		);
		expect(result).toEqual([]);
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});

	it("filters out already-injected candidates via injectedTopics set", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce('{"selected_files":["a.md"]}');
		const manifest = [
			{ filename: "a.md", name: "A", description: "desc", type: "feedback" as const, mtimeMs: 100 },
		];
		const result = await runSideQuery(
			manifest, "some query", new Set(["a.md"]), 5, "off",
			undefined, {} as any, {} as any, "/mem",
		);
		expect(result).toEqual([]);
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});
});

describe("injectSurfacedContent", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "isurf-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("reads selected files and wraps in relevant_memories tag", async () => {
		await writeFile(join(dir, "a.md"), "content A");
		await writeFile(join(dir, "b.md"), "content B");
		const result = await injectSurfacedContent(dir, ["a.md", "b.md"], 99999, 99999);
		expect(result).toContain("<relevant_memories>");
		expect(result).toContain("</relevant_memories>");
		expect(result).toContain("## a.md\ncontent A");
		expect(result).toContain("## b.md\ncontent B");
	});

	it("returns empty when selected files list is empty", async () => {
		const result = await injectSurfacedContent(dir, [], 99999, 99999);
		expect(result).toBe("");
	});

	it("respects maxInjectionBytes by truncating further blocks", async () => {
		await writeFile(join(dir, "a.md"), "X".repeat(400));
		await writeFile(join(dir, "b.md"), "Y".repeat(400));
		const result = await injectSurfacedContent(dir, ["a.md", "b.md"], 99999, 500);
		// only a.md fits within 500 bytes (block ~408 bytes incl header)
		expect(result).toContain("## a.md");
		expect(result).not.toContain("## b.md");
	});

	it("respects maxTopicBytes by truncating individual file content", async () => {
		await writeFile(join(dir, "a.md"), "X".repeat(500));
		const result = await injectSurfacedContent(dir, ["a.md"], 50, 99999);
		expect(result).toContain("## a.md");
		expect(result).toContain("[truncated:");
		expect(result.length).toBeLessThan(200);
	});
});
