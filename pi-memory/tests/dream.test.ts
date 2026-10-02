import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDreamTask, runDream, type RunDreamOpts } from "../src/dream";
import { MemoryStore, type StoreConfig } from "../src/memory-store";

const { runHeadlessAgentMock } = vi.hoisted(() => ({
	runHeadlessAgentMock: vi.fn(),
}));
vi.mock("../src/agent-runner", () => ({
	runHeadlessAgent: runHeadlessAgentMock,
}));

let dir: string;
let store: MemoryStore;

const CFG = (memoryDir: string, over: Partial<StoreConfig> = {}): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
	...over,
});

function opts(over: Partial<RunDreamOpts> = {}): RunDreamOpts {
	return {
		thinkLevel: "high",
		memoryDir: dir,
		store,
		maxLines: 200,
		model: "deepseek/deepseek-v4-flash",
		modelRegistry: {} as any,
		customTools: [],
		...over,
	};
}

async function backupDirs(): Promise<string[]> {
	return (await readdir(join(dir, ".backups")).catch(() => [] as string[])).sort();
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-dream-"));
	store = new MemoryStore(CFG(dir));
	runHeadlessAgentMock.mockReset();
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("buildDreamTask", () => {
	it("documents all seven memory actions and nothing else", () => {
		const task = buildDreamTask(200);
		for (const action of [
			' memory(action="list")',
			'memory(action="search"',
			'memory(action="add"',
			'memory(action="replace"',
			'memory(action="rename"',
			'memory(action="remove"',
			'memory(action="rebuild_index")',
		]) {
			expect(task).toContain(action.trim());
		}
		expect(task).toContain("Your ONLY tool is `memory`");
	});

	it("states that dream has no file tools", () => {
		const task = buildDreamTask(200);
		expect(task).toContain("no read, write, edit, ls or bash access");
		// v1 的工具清单格式（"- ls — list files…"）必须彻底消失
		expect(task).not.toContain("- ls —");
		expect(task).not.toContain("- read —");
		expect(task).not.toContain("- bash —");
	});

	it("keeps the four phases", () => {
		const task = buildDreamTask(200);
		expect(task).toContain("Phase 1 — Orient");
		expect(task).toContain("Phase 2 — Gather Signal");
		expect(task).toContain("Phase 3 — Consolidate");
		expect(task).toContain("Phase 4 — Prune & Index");
	});

	it("makes the index line budget a capacity-management duty", () => {
		const task = buildDreamTask(200);
		expect(task).toContain("hard limit of 200 lines");
		expect(task).toContain("Capacity management is therefore part of this job");
		expect(task).toContain("one memory per file");
		expect(task).toContain("exactly one index line per memory");
	});

	it("interpolates the configured line limit", () => {
		expect(buildDreamTask(42)).toContain("hard limit of 42 lines");
	});

	it("keeps the do-not-prune-process-rules guard", () => {
		const task = buildDreamTask(200);
		expect(task).toContain("do not prune process rules");
		expect(task).toContain('"Always do X" / "Never do Y"');
		expect(task).toContain("just because they look like meta-instructions");
	});

	it("requires self-contained descriptions and defines merge as replace + remove", () => {
		const task = buildDreamTask(200);
		expect(task).toContain("Merge = replace(target name, the merged body) + remove(the other name)");
		expect(task).toContain("It is the ONLY text a future session sees when deciding whether to recall this memory");
		expect(task).toContain('Bad:  "Debugging tips"');
	});

	it("no longer talks about topics, hooks or ## Entry blocks", () => {
		const task = buildDreamTask(200).toLowerCase();
		expect(task).not.toContain("topic");
		expect(task).not.toContain("hook");
		expect(task).not.toContain("## entry");
		expect(task).not.toContain("updated:");
	});
});

describe("runDream", () => {
	it("holds the process-wide logical lock for the whole run", async () => {
		// 短超时：没有 skipLogicalLock 的调用会被挡住，5s 的默认超时会让这个用例跑 5 秒。
		const shortStore = new MemoryStore(CFG(dir, { lock: { timeoutMs: 40, snapshotKeep: 5 } }));
		runHeadlessAgentMock.mockImplementationOnce(async () => {
			expect(shortStore.logicalLockActive()).toBe(true);
			// 持有者自己的原语调用（skipLogicalLock）必须能通过
			await expect(
				shortStore.addEntry({ name: "A", body: "正文" }, { skipLogicalLock: true, skipSnapshot: true }),
			).resolves.toMatchObject({ file: "A.md" });
			// 而没有 skipLogicalLock 的调用会被挡住（= 主 agent 的 memory add 在 dream 期间排队/超时）
			await expect(shortStore.addEntry({ name: "B", body: "正文" })).rejects.toThrow(
				/already running in this process/,
			);
			return "consolidated";
		});

		const summary = await runDream(opts({ store: shortStore }));

		expect(summary).toBe("consolidated");
		expect(shortStore.logicalLockActive()).toBe(false);
	});

	it("passes noTools='builtin' plus the dream-only customTools through to the headless agent", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce("ok");
		const customTools = [{ name: "memory" } as unknown as ToolDefinition];

		await runDream(opts({ customTools, model: "deepseek/deepseek-v4-flash" }));

		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: dir,
				thinkLevel: "high",
				maxTurns: undefined,
				timeoutMs: 600_000,
				// `tools: []` 会把 customTools 一起过滤掉（Finding C1），必须用 noTools 关 builtin。
				noTools: "builtin",
				customTools,
				model: "deepseek/deepseek-v4-flash",
			}),
		);
		expect(runHeadlessAgentMock.mock.calls[0][0].tools).toBeUndefined();
		expect(runHeadlessAgentMock.mock.calls[0][0].task).toContain("hard limit of 200 lines");
	});

	it("passes sessionPersistence through", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce("ok");
		await runDream(opts({ sessionPersistence: { enabled: true, sessionDir: "/custom" } }));
		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({ sessionPersistence: { enabled: true, sessionDir: "/custom" } }),
		);
	});

	it("snapshots the whole directory once before the agent runs", async () => {
		await store.addEntry({ name: "A", description: "摘要 A", body: "正文 A" });
		await writeFile(join(dir, ".dream-meta.json"), "{}", "utf8");
		await mkdir(join(dir, "sessions"), { recursive: true });
		await writeFile(join(dir, "sessions", "s.jsonl"), "x", "utf8");
		await rm(join(dir, ".backups"), { recursive: true, force: true });

		runHeadlessAgentMock.mockImplementationOnce(async () => {
			// 快照必须**先于** headless agent
			expect(await backupDirs()).toHaveLength(1);
			return "ok";
		});
		await runDream(opts());

		const [snapshot] = await backupDirs();
		expect(snapshot).toMatch(/-dream$/);
		const contents = (await readdir(join(dir, ".backups", snapshot))).sort();
		expect(contents).toEqual(["A.md", "MEMORY.md"]);
	});

	it("prunes old dream snapshots down to lock.snapshotKeep", async () => {
		const tiny = new MemoryStore(CFG(dir, { lock: { timeoutMs: 5000, snapshotKeep: 1 } }));
		runHeadlessAgentMock.mockResolvedValue("ok");

		await runDream(opts({ store: tiny }));
		await runDream(opts({ store: tiny }));
		await runDream(opts({ store: tiny }));

		expect(await backupDirs()).toHaveLength(1);
	});

	it("refuses to run when the logical lock is not held", async () => {
		const fakeStore = {
			cfg: { lock: { snapshotKeep: 5 } },
			withLogicalLock: (fn: () => Promise<string>) => fn(),
			logicalLockActive: () => false,
		} as unknown as MemoryStore;

		await expect(runDream(opts({ store: fakeStore }))).rejects.toThrow(
			"dream must run under the memory logical lock",
		);
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});

	it("propagates a headless-agent failure and releases the lock", async () => {
		runHeadlessAgentMock.mockRejectedValueOnce(new Error("dream failed"));

		await expect(runDream(opts())).rejects.toThrow("dream failed");
		expect(store.logicalLockActive()).toBe(false);
	});

	it("still snapshots when the memory directory is empty", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce("ok");
		await runDream(opts());

		const [snapshot] = await backupDirs();
		expect(snapshot).toMatch(/-dream$/);
		expect(await readdir(join(dir, ".backups", snapshot))).toEqual([]);
	});
});
