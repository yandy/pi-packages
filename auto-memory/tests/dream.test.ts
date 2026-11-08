import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DREAM_ACTIONS,
	MemoryStore,
	type RunDreamOpts,
	type StoreConfig,
	buildDreamTask,
	runDream,
} from "../src/index.js";
import { createReservedNameFixture, removeReservedNameFixture } from "./helpers/reserved-name.js";

/** 假的 `HeadlessAgentPort`：dream 只关心「宿主跑了这一轮、回了什么」。 */
const headlessRun = vi.fn();
const ports = { headless: { run: headlessRun } };
const dream = (o: RunDreamOpts) => runDream(o, ports);

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
		effort: "high",
		memoryDir: dir,
		store,
		maxLines: 200,
		model: "deepseek/deepseek-v4-flash",
		...over,
	};
}

async function backupDirs(): Promise<string[]> {
	return (await readdir(join(dir, ".backups")).catch(() => [] as string[])).sort();
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-dream-"));
	store = new MemoryStore(CFG(dir));
	headlessRun.mockReset();
	headlessRun.mockResolvedValue("ok");
});
afterEach(async () => {
	// win32 宿主上 rm(dir, { recursive: true }) 删不掉保留名文件，必须先经 \\?\ 前缀摘除
	await removeReservedNameFixture(dir, "con.md");
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
		headlessRun.mockImplementationOnce(async () => {
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

		const summary = await dream(opts({ store: shortStore }));

		expect(summary).toBe("consolidated");
		expect(shortStore.logicalLockActive()).toBe(false);
	});

	it("asks for no builtin tools and the seven dream-only actions, with both skips on", async () => {
		headlessRun.mockResolvedValueOnce("ok");

		await dream(opts({ model: "deepseek/deepseek-v4-flash" }));

		// 「关 builtin、只留 memory 工具」在 core 里表达为 builtinTools:"none" + memoryTool；
		// 白名单陷阱（宿主的 `tools: []` 会连 customTools 一起滤掉）由适配层负责躲开。
		expect(headlessRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: dir,
				effort: "high",
				maxTurns: undefined,
				timeoutMs: 600_000,
				builtinTools: "none",
				model: "deepseek/deepseek-v4-flash",
				memoryTool: { actions: DREAM_ACTIONS, skipLogicalLock: true, skipSnapshot: true },
			}),
		);
		expect(headlessRun.mock.calls[0][0].task).toContain("hard limit of 200 lines");
	});

	it("throws when the host declines to run the round, and releases the lock", async () => {
		headlessRun.mockResolvedValueOnce(null);

		// 静默返回空摘要会让用户以为合并成功了；dream 是显式触发的，必须显式失败。
		await expect(dream(opts())).rejects.toThrow("the host did not run the dream round");
		expect(store.logicalLockActive()).toBe(false);
	});

	it("passes sessionPersistence through", async () => {
		headlessRun.mockResolvedValueOnce("ok");
		await dream(opts({ sessionPersistence: { enabled: true, sessionDir: "/custom" } }));
		expect(headlessRun).toHaveBeenCalledWith(
			expect.objectContaining({ sessionPersistence: { enabled: true, sessionDir: "/custom" } }),
		);
	});

	it("snapshots the whole directory once before the agent runs", async () => {
		await store.addEntry({ name: "A", description: "摘要 A", body: "正文 A" });
		await writeFile(join(dir, ".dream-meta.json"), "{}", "utf8");
		await mkdir(join(dir, "sessions"), { recursive: true });
		await writeFile(join(dir, "sessions", "s.jsonl"), "x", "utf8");
		await rm(join(dir, ".backups"), { recursive: true, force: true });

		headlessRun.mockImplementationOnce(async () => {
			// 快照必须**先于** headless agent
			expect(await backupDirs()).toHaveLength(1);
			return "ok";
		});
		await dream(opts());

		const [snapshot] = await backupDirs();
		expect(snapshot).toMatch(/-dream$/);
		const contents = (await readdir(join(dir, ".backups", snapshot))).sort();
		expect(contents).toEqual(["A.md", "MEMORY.md"]);
	});

	it.skipIf(process.platform !== "win32")("skips Windows device-named files in the dream snapshot on win32", async () => {
		const win = new MemoryStore(CFG(dir));
		await createReservedNameFixture(dir, "con.md", "正文");
		await writeFile(join(dir, "ok.md"), "正文", "utf8");
		await rm(join(dir, ".backups"), { recursive: true, force: true });
		headlessRun.mockResolvedValueOnce("ok");

		await dream(opts({ store: win }));

		const [snapshot] = await backupDirs();
		const contents = (await readdir(join(dir, ".backups", snapshot))).sort();
		expect(contents).toEqual(["ok.md"]);
	});

	it.skipIf(process.platform === "win32")("keeps Windows device-named files in the dream snapshot on POSIX", async () => {
		const posix = new MemoryStore(CFG(dir));
		await writeFile(join(dir, "con.md"), "正文", "utf8");
		await writeFile(join(dir, "ok.md"), "正文", "utf8");
		await rm(join(dir, ".backups"), { recursive: true, force: true });
		headlessRun.mockResolvedValueOnce("ok");

		await dream(opts({ store: posix }));

		const [snapshot] = await backupDirs();
		const contents = (await readdir(join(dir, ".backups", snapshot))).sort();
		expect(contents).toEqual(["con.md", "ok.md"]);
	});

	it("prunes old dream snapshots down to lock.snapshotKeep", async () => {
		const tiny = new MemoryStore(CFG(dir, { lock: { timeoutMs: 5000, snapshotKeep: 1 } }));
		headlessRun.mockResolvedValue("ok");

		await dream(opts({ store: tiny }));
		await dream(opts({ store: tiny }));
		await dream(opts({ store: tiny }));

		expect(await backupDirs()).toHaveLength(1);
	});

	it("refuses to run when the logical lock is not held", async () => {
		const fakeStore = {
			cfg: { lock: { snapshotKeep: 5 } },
			withLogicalLock: (fn: () => Promise<string>) => fn(),
			logicalLockActive: () => false,
		} as unknown as MemoryStore;

		await expect(dream(opts({ store: fakeStore }))).rejects.toThrow(
			"dream must run under the memory logical lock",
		);
		expect(headlessRun).not.toHaveBeenCalled();
	});

	it("propagates a headless-agent failure and releases the lock", async () => {
		headlessRun.mockRejectedValueOnce(new Error("dream failed"));

		await expect(dream(opts())).rejects.toThrow("dream failed");
		expect(store.logicalLockActive()).toBe(false);
	});

	it("still snapshots when the memory directory is empty", async () => {
		headlessRun.mockResolvedValueOnce("ok");
		await dream(opts());

		const [snapshot] = await backupDirs();
		expect(snapshot).toMatch(/-dream$/);
		expect(await readdir(join(dir, ".backups", snapshot))).toEqual([]);
	});
});
