import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 只包住 `open` 返回的句柄（其余 fs 能力用真实实现）：记录写入与 close 都发生在锁文件**已建立**
// 之后，两者失败都必须不留任何锁残留 —— 否则失败的获取会留下一把挡住后来写入者的锁
// （0 字节的，或指向本进程的「活持有者」）。
const hoisted = vi.hoisted(() => ({ failWrite: false, failClose: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			const realWriteFile = handle.writeFile.bind(handle);
			const realClose = handle.close.bind(handle);
			handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
				if (hoisted.failWrite) throw Object.assign(new Error("EPERM: simulated write failure"), { code: "EPERM" });
				return realWriteFile(...writeArgs);
			};
			handle.close = async () => {
				if (hoisted.failClose) throw Object.assign(new Error("EIO: simulated close failure"), { code: "EIO" });
				return realClose();
			};
			return handle;
		},
	};
});

import { withLock } from "../src/fs-lock";

let dir: string;
let lockPath: string;
const FAST = { timeoutMs: 0 };

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-lock-acquire-fail-"));
	lockPath = join(dir, ".lock");
	hoisted.failWrite = false;
	hoisted.failClose = false;
});
afterEach(async () => {
	hoisted.failWrite = false;
	hoisted.failClose = false;
	await rm(dir, { recursive: true, force: true });
});

async function lockExists(): Promise<boolean> {
	return readFile(lockPath, "utf8").then(() => true, () => false);
}

describe("createExclusive failure paths", () => {
	it("does not leave a lock behind when the record write fails, and rethrows the original error", async () => {
		hoisted.failWrite = true;
		const err = await withLock(lockPath, "add", FAST, async () => "never").catch((e: unknown) => e);
		expect((err as NodeJS.ErrnoException).code).toBe("EPERM");
		expect(await lockExists()).toBe(false);
	});

	it("does not leave a self-referencing lock behind when close fails, and rethrows the original error", async () => {
		hoisted.failClose = true;
		const err = await withLock(lockPath, "add", FAST, async () => "never").catch((e: unknown) => e);
		expect((err as NodeJS.ErrnoException).code).toBe("EIO");
		expect(await lockExists()).toBe(false);
	});
});
