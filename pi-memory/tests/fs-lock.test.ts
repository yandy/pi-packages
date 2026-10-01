import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryLockedError, tryWithLock, withLock, type LockInfo } from "../src/fs-lock";

let dir: string;
let lockPath: string;
const FAST = { timeoutMs: 0 };

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-lock-"));
	lockPath = join(dir, ".lock");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeLock(info: Partial<LockInfo>): Promise<void> {
	const full: LockInfo = { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), op: "other", ...info };
	await writeFile(lockPath, JSON.stringify(full), "utf8");
}

function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", ""]);
	if (!child.pid) throw new Error("failed to spawn probe process");
	return child.pid;
}

describe("withLock", () => {
	it("writes holder info and releases on success", async () => {
		const out = await withLock(lockPath, "add", FAST, async () => {
			const raw = await readFile(lockPath, "utf8");
			expect(JSON.parse(raw)).toMatchObject({ pid: process.pid, op: "add" });
			return "done";
		});
		expect(out).toBe("done");
		await expect(readFile(lockPath, "utf8")).rejects.toThrow();
	});

	it("releases even when the body throws", async () => {
		await expect(withLock(lockPath, "add", FAST, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
		await expect(readFile(lockPath, "utf8")).rejects.toThrow();
	});

	it("never rewrites the record while held (there is no renewal — nothing expires)", async () => {
		await withLock(lockPath, "long", { timeoutMs: 0 }, async () => {
			const first = await readFile(lockPath, "utf8");
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(await readFile(lockPath, "utf8")).toBe(first);
		});
	});

	it("throws MemoryLockedError carrying the live holder", async () => {
		await writeLock({ pid: process.pid, op: "dream" });
		const err = await withLock(lockPath, "add", FAST, async () => "never").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(MemoryLockedError);
		expect((err as MemoryLockedError).holder).toMatchObject({ pid: process.pid, op: "dream" });
		expect((err as MemoryLockedError).message).toContain("locked by dream");
		expect((err as MemoryLockedError).abandoned).toBe(false);
	});

	it("times out rather than waiting forever on a live holder", async () => {
		await writeLock({ pid: process.pid });
		const started = Date.now();
		await expect(withLock(lockPath, "add", { timeoutMs: 120, pollMs: 20 }, async () => "x")).rejects.toThrow(
			MemoryLockedError,
		);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	// 永不自动回收：另一个进程崩溃留下的锁没有任何人能释放它。回收需要「移走别人的锁」，
	// 而 POSIX 没有 compare-and-replace —— 任何移走式接管都存在可被合法抢占的空窗，一旦移走的是
	// 活持有者的记录，互斥就无法再保证。所以这里选择「立刻报一条可操作的错误」。
	it("fails immediately, with an actionable message, on a lock abandoned by a dead process", async () => {
		await writeLock({ pid: deadPid(), op: "dream" });
		const started = Date.now();
		const err = await withLock(lockPath, "add", { timeoutMs: 5000 }, async () => "never").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(MemoryLockedError);
		expect((err as MemoryLockedError).abandoned).toBe(true);
		expect((err as MemoryLockedError).message).toContain(lockPath);
		expect((err as MemoryLockedError).message).toContain("delete the file to clear it");
		expect(Date.now() - started).toBeLessThan(1000);
		// 没有被回收：锁文件仍在原地，等人处理
		expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ op: "dream" });
	});

	it("fails immediately on an unreadable or foreign lock record", async () => {
		await writeFile(lockPath, "not json", "utf8");
		await expect(withLock(lockPath, "add", FAST, async () => "x")).rejects.toThrow(/abandoned/);

		await writeFile(lockPath, "123", "utf8");
		await expect(withLock(lockPath, "add", FAST, async () => "x")).rejects.toThrow(MemoryLockedError);

		await writeFile(lockPath, "{}", "utf8");
		await expect(tryWithLock(lockPath, "add", FAST, async () => "x")).rejects.toThrow(MemoryLockedError);
	});

	it("still refuses a lock held on another host (liveness is unknowable, so never reclaimed)", async () => {
		await writeLock({ hostname: "some-other-host", pid: 1, op: "dream" });
		const err = await withLock(lockPath, "add", FAST, async () => "never").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(MemoryLockedError);
		// 无法判断存活 → 一律按活持有者处理，绝不接管
		expect((err as MemoryLockedError).abandoned).toBe(false);
		expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ hostname: "some-other-host" });
	});

	it("does not delete a lock that another process now owns", async () => {
		await withLock(lockPath, "mine", FAST, async () => {
			await writeLock({ pid: process.pid + 1, op: "thief" });
		});
		expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ op: "thief", pid: process.pid + 1 });
	});

	it("leaves no temporary files behind after acquiring or failing to acquire", async () => {
		await withLock(lockPath, "a", FAST, async () => "ok");
		await writeLock({ pid: process.pid });
		await expect(withLock(lockPath, "b", FAST, async () => "no")).rejects.toThrow(MemoryLockedError);
		expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	// 这个用例不只是「互斥守卫」：它实际抓到过一个真 bug —— 5 个调用者高速churn 锁时，
	// 「link 失败 → 读取」之间锁被释放，而早期实现把「读不到文件」当成「无法解释的记录」，
	// 于是把「刚被释放」误报成「遗弃的锁」。absent 与 unreadable 必须分开。
	it("serialises overlapping withLock calls", async () => {
		let active = 0;
		let maxActive = 0;
		const completed: number[] = [];
		await Promise.all(
			[1, 2, 3, 4, 5].map((n) =>
				withLock(lockPath, "seq", { timeoutMs: 5000, pollMs: 5 }, async () => {
					active += 1;
					maxActive = Math.max(maxActive, active);
					await new Promise((resolve) => setTimeout(resolve, 5));
					completed.push(n);
					active -= 1;
				}),
			),
		);
		expect(maxActive).toBe(1);
		expect(completed).toHaveLength(5);
	});
});

describe("tryWithLock", () => {
	it("returns null without waiting when a live process holds the lock", async () => {
		await writeLock({ pid: process.pid });
		await expect(tryWithLock(lockPath, "extract", FAST, async () => "x")).resolves.toBeNull();
	});

	it("runs the body when the lock is free", async () => {
		await expect(tryWithLock(lockPath, "extract", FAST, async () => "ran")).resolves.toBe("ran");
	});
});
