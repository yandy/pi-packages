import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadIndexSnapshot, buildInjection, scanTopics, buildSurfacingPrompt, injectSurfacedContent, runSideQuery } from "../src/inject";

vi.mock("@yandy0725/pi-subagents", () => ({
	getSubagentsService: vi.fn(),
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

describe("buildSurfacingPrompt", () => {
	it("builds prompt with manifest and user message", () => {
		const manifest = [
			{ filename: "a.md", name: "Alpha", description: "first topic", type: "feedback" as const, mtimeMs: 100 },
			{ filename: "b.md", name: "Beta", description: "second topic", type: "project" as const, mtimeMs: 200 },
		];
		const prompt = buildSurfacingPrompt(manifest, "how do I debug SSH?", new Set(["b.md"]));
		expect(prompt).toContain("[feedback] a.md — first topic");
		expect(prompt).toContain("[project] b.md — second topic");
		expect(prompt).toContain("how do I debug SSH?");
		expect(prompt).toContain("already injected");
	});

	it("omits already-injected note when none injected", () => {
		const manifest = [
			{ filename: "a.md", name: "Alpha", description: "first topic", type: "feedback" as const, mtimeMs: 100 },
		];
		const prompt = buildSurfacingPrompt(manifest, "hello", new Set());
		expect(prompt).toContain("[feedback] a.md — first topic");
		expect(prompt).not.toContain("already injected");
	});
});

describe("runSideQuery", () => {
	it("spawns with thinkingLevel=off and maxTurns=1", async () => {
		const { getSubagentsService } = await import("@yandy0725/pi-subagents");

		const completedHandlers: Array<(data: any) => void> = [];
		const fakeService = {
			spawn: vi.fn().mockReturnValue("agent-sq-1"),
			getRecord: vi.fn().mockReturnValue({ result: '{"selected_files":["a.md"]}' }),
			registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
		};
		(getSubagentsService as any).mockReturnValue(fakeService);

		const events = {
			on: vi.fn((channel: string, handler: (data: any) => void) => {
				if (channel === "subagents:completed") completedHandlers.push(handler);
				return () => {};
			}),
		};

		const manifest = [
			{ filename: "a.md", name: "A", description: "desc", type: "feedback" as const, mtimeMs: 100 },
		];

		const promise = runSideQuery("user query about something", manifest, 5, "off", events as any);

		expect(fakeService.spawn).toHaveBeenCalledWith(
			"memory-agent",
			expect.any(String),
			{ maxTurns: 1, inheritContext: false, thinkingLevel: "off", foreground: true, bypassQueue: true },
		);

		// Complete agent so promise resolves
		completedHandlers[0]({ id: "agent-sq-1" });
		await promise;
	});

	it("forwards non-default thinkLevel to spawn", async () => {
		const { getSubagentsService } = await import("@yandy0725/pi-subagents");

		const completedHandlers: Array<(data: any) => void> = [];
		const fakeService = {
			spawn: vi.fn().mockReturnValue("agent-sq-2"),
			getRecord: vi.fn().mockReturnValue({ result: '{"selected_files":["a.md"]}' }),
			registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
		};
		(getSubagentsService as any).mockReturnValue(fakeService);

		const events = {
			on: vi.fn((channel: string, handler: (data: any) => void) => {
				if (channel === "subagents:completed") completedHandlers.push(handler);
				return () => {};
			}),
		};

		const manifest = [
			{ filename: "a.md", name: "A", description: "desc", type: "feedback" as const, mtimeMs: 100 },
		];

		const promise = runSideQuery("user query", manifest, 5, "medium", events as any);

		expect(fakeService.spawn).toHaveBeenCalledWith(
			"memory-agent",
			expect.any(String),
			{ maxTurns: 1, inheritContext: false, thinkingLevel: "medium", foreground: true, bypassQueue: true },
		);

		completedHandlers[0]({ id: "agent-sq-2" });
		await promise;
	});

	it("falls back to keyword matching when service unavailable", async () => {
		const { getSubagentsService } = await import("@yandy0725/pi-subagents");
		(getSubagentsService as any).mockReturnValue(undefined);

		const manifest = [
			{ filename: "debugging.md", name: "Debugging", description: "SSH tips and tricks", type: "project" as const, mtimeMs: 100 },
			{ filename: "irrelevant.md", name: "Irrelevant", description: "nothing to match", type: "feedback" as const, mtimeMs: 200 },
		];

		const result = await runSideQuery("I need to debug SSH issues", manifest, 5, "off");
		expect(result).toEqual(["debugging.md"]);
	});

	it("returns empty when no candidates remain", async () => {
		const manifest: any[] = [];
		const result = await runSideQuery("some prompt", manifest, 5, "off");
		expect(result).toEqual([]);
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
