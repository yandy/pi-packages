import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 只替换 cp / mkdir（快照里仅有的两个物理写入调用），其余 fs 能力用真实实现。
// 与 memory-store-retry.test.ts 同一套局部 mock 手法。
const hoisted = vi.hoisted(() => ({
	cp: vi.fn(),
	mkdir: vi.fn(),
	real: {} as { cp: (...args: never[]) => Promise<unknown>; mkdir: (...args: never[]) => Promise<unknown> },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	hoisted.real.cp = actual.cp as never;
	hoisted.real.mkdir = actual.mkdir as never;
	hoisted.cp.mockImplementation(actual.cp);
	hoisted.mkdir.mockImplementation(actual.mkdir);
	return { ...actual, cp: hoisted.cp, mkdir: hoisted.mkdir };
});

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory-store";
import { createSnapshot } from "../src/snapshot";

let memoryDir: string;
let backupRoot: string;

const at = (iso: string) => () => new Date(iso);
const NOW = at("2026-10-01T00:00:01.000Z");
const transient = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

/**
 * 让 `fn` 的前 `times` 次调用以 `code` 失败，之后原样交给真实实现。
 * **不用 `mockImplementationOnce`**：没有重试时注入不会被消费干净，残留的 once 队列会串到后面的
 * 用例里（那时失败的就不只是被测行为了）。这里只装基础实现，`beforeEach` 一律装回真实实现。
 */
function failFirst(fn: typeof hoisted.cp, real: (...args: never[]) => Promise<unknown>, times: number, code: string) {
	let left = times;
	fn.mockImplementation((...args: never[]) => {
		if (left-- > 0) return Promise.reject(transient(code));
		return real(...args);
	});
}

beforeEach(async () => {
	memoryDir = await mkdtemp(join(tmpdir(), "mem-snapshot-retry-"));
	backupRoot = join(memoryDir, ".backups");
	await writeFile(join(memoryDir, "MEMORY.md"), "# Memory Index\n", "utf8");
	await writeFile(join(memoryDir, "a.md"), "A\n", "utf8");
	hoisted.cp.mockClear().mockImplementation(hoisted.real.cp);
	hoisted.mkdir.mockClear().mockImplementation(hoisted.real.mkdir);
});
afterEach(async () => {
	await rm(memoryDir, { recursive: true, force: true });
});

describe("createSnapshot 的瞬时错误重试", () => {
	it("crosses a transient EBUSY on cp and still copies the file", async () => {
		failFirst(hoisted.cp, hoisted.real.cp, 1, "EBUSY");

		const dir = await createSnapshot(backupRoot, "write", ["MEMORY.md", "a.md"], memoryDir, { keep: 5, now: NOW });

		expect(dir).toBe(join(backupRoot, "2026-10-01T00-00-01-000Z-write"));
		expect(await readdir(dir)).toEqual(["MEMORY.md", "a.md"]);
		expect(await readFile(join(dir, "a.md"), "utf8")).toBe("A\n");
		expect(hoisted.cp.mock.calls.length).toBeGreaterThanOrEqual(3); // 两个文件 + 至少一次重试
	});

	it("crosses a transient EBUSY on mkdir (backup root and snapshot dir) and still creates the directory", async () => {
		failFirst(hoisted.mkdir, hoisted.real.mkdir, 2, "EBUSY");

		const dir = await createSnapshot(backupRoot, "write", ["MEMORY.md"], memoryDir, { keep: 5, now: NOW });

		expect(await readdir(dir)).toEqual(["MEMORY.md"]);
		expect(await readdir(backupRoot)).toEqual(["2026-10-01T00-00-01-000Z-write"]);
	});

	it("retries EPERM when the caller says win32 (antivirus / sync client)", async () => {
		failFirst(hoisted.cp, hoisted.real.cp, 1, "EPERM");

		const dir = await createSnapshot(backupRoot, "write", ["MEMORY.md"], memoryDir, {
			keep: 5,
			now: NOW,
			platform: "win32",
		});

		expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("# Memory Index\n");
	});

	it("still fails closed on a POSIX EPERM (the platform option really reaches withFsRetry)", async () => {
		failFirst(hoisted.cp, hoisted.real.cp, 1, "EPERM");

		await expect(
			createSnapshot(backupRoot, "write", ["MEMORY.md"], memoryDir, { keep: 5, now: NOW, platform: "linux" }),
		).rejects.toThrow("EPERM");
		expect(hoisted.cp).toHaveBeenCalledTimes(1);
	});

	it("keeps EEXIST as the try-the-next-name signal instead of letting the retry swallow it", async () => {
		await mkdir(join(backupRoot, "2026-10-01T00-00-01-000Z-write"), { recursive: true });

		const dir = await createSnapshot(backupRoot, "write", ["MEMORY.md"], memoryDir, {
			keep: 5,
			now: NOW,
			platform: "win32",
		});

		expect(dir).toBe(join(backupRoot, "2026-10-01T00-00-01-000Z-write-2"));
		expect((await readdir(backupRoot)).sort()).toEqual([
			"2026-10-01T00-00-01-000Z-write",
			"2026-10-01T00-00-01-000Z-write-2",
		]);
	});

	it("keeps skipping files that do not exist while retrying", async () => {
		const dir = await createSnapshot(backupRoot, "write", ["MEMORY.md", "missing.md"], memoryDir, {
			keep: 5,
			now: NOW,
			platform: "win32",
		});

		expect(await readdir(dir)).toEqual(["MEMORY.md"]);
	});
});

describe("快照重试的平台由调用方传入", () => {
	it("MemoryStore 把 cfg.platform 传下去：win32 上一次瞬时 EPERM 不再让写入失败", async () => {
		failFirst(hoisted.cp, hoisted.real.cp, 1, "EPERM");
		const store = new MemoryStore({
			memoryDir,
			indexMaxLines: 200,
			indexMaxBytes: 25600,
			lock: { timeoutMs: 5000, snapshotKeep: 5 },
			platform: "win32",
		});

		await expect(store.addEntry({ name: "A", body: "正文" })).resolves.toMatchObject({ file: "A.md" });
		expect(await store.readEntry("A")).toMatchObject({ name: "A", body: "正文" });
		expect(hoisted.cp.mock.calls.length).toBeGreaterThanOrEqual(2); // 至少一次重试
	});
});
