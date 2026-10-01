import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildInjection,
	buildSideQueryTask,
	type EntryManifest,
	injectSurfacedContent,
	loadIndexSnapshot,
	runSideQuery,
	SIDE_QUERY_MAX_ENTRIES,
	scanEntries,
	truncateForInjection,
} from "../src/inject";
import { MemoryStore, type StoreConfig } from "../src/memory-store";

const { runHeadlessAgentMock } = vi.hoisted(() => ({
	runHeadlessAgentMock: vi.fn(),
}));
vi.mock("../src/agent-runner", () => ({
	runHeadlessAgent: runHeadlessAgentMock,
}));

const CFG = (memoryDir: string): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
});

const SAMPLE_INDEX = `- [Architecture](architecture.md) — Go API setup patterns
- [Builds](builds.md) — npm scripts and make targets
- [Debugging](debugging.md) — SSH port 2222, MySQL timeout`;

/** 直接落一个 v2 entry 文件（绕过 store，用来精确控制 modified）。 */
function entryFile(name: string, description: string, type: string, modified: string, body: string): string {
	return [
		"---",
		`name: ${name}`,
		`description: ${description}`,
		`type: ${type}`,
		"created: 2026-01-01",
		`modified: ${modified}`,
		"---",
		"",
		body,
		"",
	].join("\n");
}

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

describe("truncateForInjection", () => {
	it("keeps content under limits", () => {
		const r = truncateForInjection(SAMPLE_INDEX, 200, 25600);
		expect(r.ok).toBe(true);
		expect(r.truncated).toBe(false);
	});

	it("truncates by line count", () => {
		const many = Array.from({ length: 10 }, (_, i) => `- [T${i}](t${i}.md) — desc`).join("\n");
		const r = truncateForInjection(many, 3, 25600);
		expect(r.truncated).toBe(true);
		expect(r.content.split("\n").length).toBe(4);
		expect(r.content).toContain("[truncated:");
	});

	it("truncates by byte count", () => {
		const longLine = `- [A very long title that exceeds the byte limit](example.md) — hook`;
		const r = truncateForInjection(longLine, 100, 50);
		expect(r.truncated).toBe(true);
		expect(Buffer.byteLength(r.content.split("\n")[0], "utf8")).toBeLessThanOrEqual(50);
	});
});

describe("loadIndexSnapshot", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-inj-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns empty string when MEMORY.md missing", async () => {
		expect(await loadIndexSnapshot(dir, 200, 25600)).toBe("");
	});

	it("returns truncated content when MEMORY.md exists", async () => {
		await writeFile(join(dir, "MEMORY.md"), "- [A](a.md) — desc a\n- [B](b.md) — desc b");
		const snap = await loadIndexSnapshot(dir, 200, 25600);
		expect(snap).toContain("# Memory Index");
		expect(snap).toContain("- [A](a.md)");
	});

	it("truncates to limits", async () => {
		const many = Array.from({ length: 10 }, (_, i) => `- [T${i}](t${i}.md) — d${i}`).join("\n");
		await writeFile(join(dir, "MEMORY.md"), many);
		expect(await loadIndexSnapshot(dir, 3, 25600)).toContain("[truncated:");
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

describe("scanEntries", () => {
	let dir: string;
	let store: MemoryStore;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-scan-"));
		store = new MemoryStore(CFG(dir));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("lists entry files only, newest first", async () => {
		await writeFile(
			join(dir, "older.md"),
			entryFile("Older", "旧记忆", "project", "2026-01-01T00:00:00.000Z", "旧正文"),
		);
		await writeFile(
			join(dir, "newer.md"),
			entryFile("Newer", "新记忆", "user", "2026-06-01T00:00:00.000Z", "新正文"),
		);
		await writeFile(join(dir, "MEMORY.md"), SAMPLE_INDEX);
		await writeFile(join(dir, "notes.txt"), "not markdown");
		await writeFile(join(dir, ".dream-meta.json"), "{}");

		const entries = await scanEntries(store);

		expect(entries.map((e) => e.file)).toEqual(["newer.md", "older.md"]);
		expect(entries[0]).toEqual({
			file: "newer.md",
			name: "Newer",
			description: "新记忆",
			type: "user",
			modified: "2026-06-01T00:00:00.000Z",
		});
	});

	it("sees entries written through the store", async () => {
		const { file } = await store.addEntry({ name: "A", description: "摘要 A", body: "正文 A" });
		const entries = await scanEntries(store);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ file, name: "A", description: "摘要 A", type: "feedback" });
	});

	// Finding I2：清单无界。v1 的候选集合就是索引本身（有上限），v2 必须同样恢复界。
	it("caps the manifest at 200 entries, keeping the newest", async () => {
		for (let i = 0; i < 201; i++) {
			const modified = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
			await writeFile(
				join(dir, `e${String(i).padStart(3, "0")}.md`),
				entryFile(`E${i}`, `d${i}`, "project", modified, `正文 ${i}`),
			);
		}

		const entries = await scanEntries(store);

		expect(entries).toHaveLength(SIDE_QUERY_MAX_ENTRIES);
		expect(entries[0].name).toBe("E200");
		expect(entries[entries.length - 1].name).toBe("E1");
		expect(entries.some((e) => e.name === "E0")).toBe(false);
	});

	it("re-reads a file whose mtime changed and keeps the cached one untouched", async () => {
		const path = join(dir, "a.md");
		await writeFile(path, entryFile("A", "第一版摘要", "feedback", "2026-01-01T00:00:00.000Z", "正文"));
		// 先把 mtime 钉成毫秒确定值，否则 writeFile 的亚毫秒 mtime 与 utimes 的毫秒精度永不相等，
		// 缓存必然 miss，这个用例就测不到「缓存命中」了（Plan A ledger R21）。
		const past = new Date(Date.now() - 60_000);
		await utimes(path, past, past);
		expect((await scanEntries(store))[0].description).toBe("第一版摘要");

		await writeFile(path, entryFile("A", "第二版摘要", "feedback", "2026-01-02T00:00:00.000Z", "正文"));
		const now = new Date();
		await utimes(path, now, now);

		const entries = await scanEntries(store);
		expect(entries[0].description).toBe("第二版摘要");
		expect(entries[0].modified).toBe("2026-01-02T00:00:00.000Z");
	});

	it("returns an empty manifest for an empty directory", async () => {
		expect(await scanEntries(store)).toEqual([]);
	});
});

describe("buildSideQueryTask", () => {
	it("keeps the JSON output protocol and the user query", () => {
		const task = buildSideQueryTask([manifest("a.md")], "how do I debug SSH?", 3);
		expect(task).toContain("You are a memory relevance selector. Select up to 3 memory files");
		expect(task).toContain("=== Memory Files ===");
		expect(task).toContain("[feedback] a.md — description of a.md");
		expect(task).toContain("=== User Query ===");
		expect(task).toContain("how do I debug SSH?");
		expect(task).toContain('Respond with ONLY a JSON object: {"selected_files": ["filename.md", ...]}');
	});

	it("no longer talks about topics", () => {
		const task = buildSideQueryTask([manifest("a.md")], "q", 3);
		expect(task.toLowerCase()).not.toContain("topic");
	});

	it("splits the manifest budget evenly instead of hard-cutting at 80 chars", () => {
		const wide = Array.from({ length: 40 }, (_, i) =>
			manifest(`e${i}.md`, { description: "x".repeat(500) }),
		);
		const wideLines = buildSideQueryTask(wide, "q", 3)
			.split("\n")
			.filter((line) => line.startsWith("[feedback]"));
		// 4000 / 40 = 100：每条 description 保留 100 字符（v1 恒为 80）
		expect(wideLines).toHaveLength(40);
		expect(wideLines[0].split("— ")[1]).toHaveLength(100);

		const narrow = Array.from({ length: 100 }, (_, i) =>
			manifest(`e${i}.md`, { description: "y".repeat(500) }),
		);
		const narrowLines = buildSideQueryTask(narrow, "q", 3)
			.split("\n")
			.filter((line) => line.startsWith("[feedback]"));
		// 4000 / 100 = 40 → 夹到下限 80
		expect(narrowLines[0].split("— ")[1]).toHaveLength(80);
	});
});

describe("injectSurfacedContent", () => {
	let dir: string;
	let store: MemoryStore;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-isurf-"));
		store = new MemoryStore(CFG(dir));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("renders the entry name (not the file name) and wraps in relevant_memories", async () => {
		await store.addEntry({ name: "SSH port on staging", description: "2222", body: "staging 用 2222 端口。" });
		await store.addEntry({ name: "MySQL timeout", description: "30s", body: "MySQL 超时 30s。" });

		const out = await injectSurfacedContent(store, ["SSH-port-on-staging.md", "MySQL-timeout.md"], 99999, 99999);

		expect(out.startsWith("<relevant_memories>\n")).toBe(true);
		expect(out.endsWith("\n</relevant_memories>")).toBe(true);
		expect(out).toContain("## SSH port on staging\nstaging 用 2222 端口。");
		expect(out).toContain("## MySQL timeout\nMySQL 超时 30s。");
		expect(out).not.toContain("name: SSH port on staging");
	});

	it("returns empty when the selection is empty", async () => {
		expect(await injectSurfacedContent(store, [], 99999, 99999)).toBe("");
	});

	it("skips files that no longer resolve to an entry", async () => {
		await store.addEntry({ name: "A", description: "a", body: "正文 A" });
		expect(await injectSurfacedContent(store, ["gone.md"], 99999, 99999)).toBe("");
		const out = await injectSurfacedContent(store, ["gone.md", "A.md"], 99999, 99999);
		expect(out).toContain("## A");
		expect(out).not.toContain("gone.md");
	});

	it("truncates a single entry to maxEntryBytes", async () => {
		await store.addEntry({ name: "A", description: "a", body: "X".repeat(500) });
		const out = await injectSurfacedContent(store, ["A.md"], 50, 99999);
		expect(out).toContain("## A");
		expect(out).toContain("[truncated:");
		expect(out.length).toBeLessThan(200);
	});

	it("stops at the total injection budget", async () => {
		await store.addEntry({ name: "A", description: "a", body: "X".repeat(400) });
		await store.addEntry({ name: "B", description: "b", body: "Y".repeat(400) });
		const out = await injectSurfacedContent(store, ["A.md", "B.md"], 99999, 500);
		expect(out).toContain("## A");
		expect(out).not.toContain("## B");
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
			undefined,
			{} as any,
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
			undefined,
			{} as any,
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
			undefined,
			{} as any,
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
			undefined,
			{} as any,
			{} as any,
			"/mem",
		);
		expect(result).toEqual([]);
	});

	it("returns [] when no candidates remain", async () => {
		const result = await runSideQuery([], "some prompt", new Set(), 5, "off", undefined, {} as any, {} as any, "/mem");
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
			undefined,
			{} as any,
			{} as any,
			"/mem",
		);
		expect(result).toEqual([]);
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});
});
