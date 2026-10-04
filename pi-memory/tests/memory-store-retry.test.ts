import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 只替换 writeFile / unlink，其余 fs 能力用真实实现（其余模块依赖 readFile/readdir/stat）。
const hoisted = vi.hoisted(() => ({ writeFile: vi.fn(), unlink: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	hoisted.writeFile.mockImplementation(actual.writeFile);
	hoisted.unlink.mockImplementation(actual.unlink);
	return { ...actual, writeFile: hoisted.writeFile, unlink: hoisted.unlink };
});

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory-store";

let dir: string;

const transient = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-retry-"));
	await mkdir(dir, { recursive: true });
	hoisted.writeFile.mockClear();
	hoisted.unlink.mockClear();
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function store(platform: NodeJS.Platform): MemoryStore {
	return new MemoryStore({
		memoryDir: dir,
		indexMaxLines: 200,
		indexMaxBytes: 25600,
		lock: { timeoutMs: 5000, snapshotKeep: 5 },
		platform,
	});
}

describe("MemoryStore 的瞬时错误重试", () => {
	it("retries a transient EPERM on win32 and still writes the entry", async () => {
		const real = hoisted.writeFile.getMockImplementation()!;
		hoisted.writeFile.mockImplementationOnce(() => Promise.reject(transient("EPERM"))).mockImplementation(real);

		const win = store("win32");
		await expect(win.addEntry({ name: "A", body: "正文" })).resolves.toMatchObject({ file: "A.md" });
		expect(await win.readEntry("A")).toMatchObject({ name: "A", body: "正文" });
		expect(hoisted.writeFile.mock.calls.length).toBeGreaterThanOrEqual(3); // entry + 索引 + 至少一次重试
	});

	it("does not retry EPERM on POSIX", async () => {
		hoisted.writeFile.mockImplementationOnce(() => Promise.reject(transient("EPERM")));

		await expect(store("linux").addEntry({ name: "A", body: "正文" })).rejects.toThrow("EPERM");
		expect(hoisted.writeFile).toHaveBeenCalledTimes(1);
	});

	it("retries a transient EBUSY on unlink on every platform", async () => {
		const win = store("linux");
		await win.addEntry({ name: "A", body: "正文" });
		const real = hoisted.unlink.getMockImplementation()!;
		// 不能用 mockImplementationOnce：取锁路径（fs-lock 的临时文件清理）也会调用 unlink 并吞掉错误，
		// 会把唯一一次注入的 EBUSY 吃掉。这里只让 entry 文件的 unlink 失败一次，其余原样交给真实实现。
		let rejectEntryUnlink = true;
		hoisted.unlink.mockImplementation((path: string) => {
			if (rejectEntryUnlink && String(path).endsWith("A.md")) {
				rejectEntryUnlink = false;
				return Promise.reject(transient("EBUSY"));
			}
			return real(path);
		});

		await expect(win.removeEntry("A")).resolves.toBeUndefined();
		expect(await win.readEntry("A")).toBeNull();
	});
});
