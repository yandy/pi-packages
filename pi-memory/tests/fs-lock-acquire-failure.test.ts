import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 只包住 `open` 返回的句柄（其余 fs 能力用真实实现）：记录写入与 close 都发生在锁文件**已建立**
// 之后，两者失败都必须不留任何锁残留 —— 否则失败的获取会留下一把挡住后来写入者的锁
// （0 字节的，或指向本进程的「活持有者」）。
const hoisted = vi.hoisted(() => ({ failWrite: false, failClose: false, shortWriteOnce: false }));

const transient = (code: string, message: string): NodeJS.ErrnoException =>
	Object.assign(new Error(`${code}: ${message}`), { code });

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			const realWrite = handle.write.bind(handle);
			const realWriteFile = handle.writeFile.bind(handle);
			const realClose = handle.close.bind(handle);
			// 实现走的是「定长位置写」重载（`write(buffer, offset, length, position)`）：
			// 失败注入与「只写了一半」都打在它身上。
			handle.write = (async (
				buffer: Uint8Array,
				offset?: number | null,
				length?: number | null,
				position?: number | null,
			) => {
				if (hoisted.failWrite) throw transient("EPERM", "simulated write failure");
				const asked = length ?? buffer.byteLength - (offset ?? 0);
				if (hoisted.shortWriteOnce) {
					hoisted.shortWriteOnce = false;
					// 如实上报「只写进去一半」：完整性校验必须靠这个返回值发现缺口并续写。
					return realWrite(buffer, offset, Math.max(1, Math.floor(asked / 2)), position);
				}
				return realWrite(buffer, offset, length, position);
			}) as unknown as typeof handle.write;
			// 同一面注入也打在 `writeFile` 上：修复前的实现用的是它，而它写在**当前位置** ——
			// 「半截落盘 + 瞬时错误」会让重试把完整的第二个 JSON 追加到后面（实测得到 `{…}{…}`）。
			// 于是短写用例对修复前/修复后的实现分别是红的/绿的，而不是一律绿。
			// 注意：`failWrite` **只**打在 `write` 上（实现用的那一面）—— 若注入面与实现不匹配，
			// 下面两条失败用例会「因为错误的原因」变绿，revert 实现即可暴露。
			handle.writeFile = (async (
				data: string | Uint8Array,
				options?: BufferEncoding | { encoding?: BufferEncoding },
			) => {
				if (hoisted.shortWriteOnce) {
					hoisted.shortWriteOnce = false;
					const whole = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
					await realWriteFile(whole.slice(0, Math.max(1, Math.floor(whole.length / 2))), "utf8");
					throw transient("EBUSY", "simulated transient write failure after a partial record");
				}
				return realWriteFile(data, options);
			}) as unknown as typeof handle.writeFile;
			handle.close = async () => {
				if (hoisted.failClose) throw transient("EIO", "simulated close failure");
				return realClose();
			};
			return handle;
		},
	};
});

import { readLockStatus, withLock } from "../src/fs-lock";

let dir: string;
let lockPath: string;
const FAST = { timeoutMs: 0 };

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-lock-acquire-fail-"));
	lockPath = join(dir, ".lock");
	hoisted.failWrite = false;
	hoisted.failClose = false;
	hoisted.shortWriteOnce = false;
});
afterEach(async () => {
	hoisted.failWrite = false;
	hoisted.failClose = false;
	hoisted.shortWriteOnce = false;
	await rm(dir, { recursive: true, force: true });
});

async function lockExists(): Promise<boolean> {
	return readFile(lockPath, "utf8").then(
		() => true,
		() => false,
	);
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

describe("createExclusive record completeness", () => {
	it("finishes the record after a short write instead of appending a second JSON blob", async () => {
		hoisted.shortWriteOnce = true;
		let raw = "";
		let status: Awaited<ReturnType<typeof readLockStatus>> | null = null;

		const result = await withLock(lockPath, "add", FAST, async () => {
			raw = await readFile(lockPath, "utf8");
			status = await readLockStatus(lockPath);
			return "body-value";
		});

		// (a) 获取成功了：短写被续写完，没有变成一次失败的获取
		expect(result).toBe("body-value");
		// (b) 文件里是**一条**可解析的记录。两个 JSON 拼接（`{…}{…}`）会让 JSON.parse 直接抛错，
		// 而那样读者判 unreadable → 活持有者被误报成「遗弃的锁」，且持有者自己也释放不掉它。
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		expect(parsed).toMatchObject({ pid: process.pid, op: "add", hostname: expect.any(String) });
		expect(raw).toBe(JSON.stringify(parsed)); // 没有前缀/后缀残留字节
		// (c) 持有期间对外的诊断视图是 held（不是 unreadable）
		expect(status).toMatchObject({ kind: "held", holder: { pid: process.pid, op: "add" } });
	});
});
