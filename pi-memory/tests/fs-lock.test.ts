import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryLockedError, tryWithLock, withLock, type LockInfo } from "../src/fs-lock";

let dir: string;
let lockPath: string;
const FAST = { timeoutMs: 0, ttlMs: 600_000 };

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
		await expect(withLock(lockPath, "add", FAST, async () => {
			throw new Error("boom");
		})).rejects.toThrow("boom");
		await expect(readFile(lockPath, "utf8")).rejects.toThrow();
	});

	it("throws MemoryLockedError carrying the holder when a live process holds it", async () => {
		await writeLock({ pid: process.pid, op: "dream" });
		const err = await withLock(lockPath, "add", { ...FAST, timeoutMs: 0 }, async () => "never").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(MemoryLockedError);
		expect((err as MemoryLockedError).holder).toMatchObject({ pid: process.pid, op: "dream" });
		expect((err as MemoryLockedError).message).toContain("locked by dream");
	});

	it("times out rather than waiting forever", async () => {
		await writeLock({ pid: process.pid });
		const started = Date.now();
		await expect(withLock(lockPath, "add", { ttlMs: 600_000, timeoutMs: 120, pollMs: 20 }, async () => "x")).rejects.toThrow(
			MemoryLockedError,
		);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("reclaims a lock whose owning process is dead", async () => {
		await writeLock({ pid: deadPid(), op: "dream" });
		const out = await withLock(lockPath, "add", FAST, async () => "reclaimed");
		expect(out).toBe("reclaimed");
	});

	it("reclaims a lock past its ttl", async () => {
		await writeLock({ pid: process.pid, startedAt: new Date(Date.now() - 3_600_000).toISOString() });
		const out = await withLock(lockPath, "add", { timeoutMs: 0, ttlMs: 60_000 }, async () => "stale");
		expect(out).toBe("stale");
	});

	it("reclaims an unreadable lock file", async () => {
		await writeFile(lockPath, "not json", "utf8");
		const out = await withLock(lockPath, "add", FAST, async () => "garbage");
		expect(out).toBe("garbage");
	});

	// 合法 JSON 但不是锁记录时也必须能回收。否则 `isStale` 会因 hostname 不是字符串而跳过 pid 检查、
	// 又因 `Date.parse(undefined)` 是 NaN 而跳过 TTL 检查 —— 锁永远不会变 stale，调用方永远超时。
	it("reclaims a lock file that parses as JSON but is not a lock record", async () => {
		await writeFile(lockPath, "123", "utf8");
		await expect(withLock(lockPath, "add", FAST, async () => "reclaimed")).resolves.toBe("reclaimed");
		await writeFile(lockPath, "{}", "utf8");
		await expect(tryWithLock(lockPath, "add", FAST, async () => "reclaimed")).resolves.toBe("reclaimed");
	});

	it("leaves no temporary files behind after acquiring or failing to acquire", async () => {
		await withLock(lockPath, "a", FAST, async () => "ok");
		await writeLock({ pid: process.pid });
		await expect(withLock(lockPath, "b", FAST, async () => "no")).rejects.toThrow(MemoryLockedError);
		expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	// 互斥性的直接守卫：并发竞争同一个锁时，临界区内的并发数必须恒为 1。
	it("serialises overlapping withLock calls", async () => {
		let active = 0;
		let maxActive = 0;
		const completed: number[] = [];
		await Promise.all(
			[1, 2, 3, 4, 5].map((n) =>
				withLock(lockPath, "seq", { timeoutMs: 5000, ttlMs: 600_000, pollMs: 5 }, async () => {
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

	// 续约（心跳）守卫：TTL 只对「不再续约的持有者」生效。dream 是 headless 智能体（200 条目、
	// thinkLevel: high），跑满 10 分钟完全现实 —— 健康的长任务不得被别的写者判为 stale 后抢锁。
	// renewIntervalMs = max(1000, ttl/2)，因此 ttl 2000ms → 每 1000ms 续约一次。
	// 等到 2500ms：已续约的记录年龄约 500ms（< ttl，抢不到）；未续约的记录年龄 2500ms（> ttl，会被抢走）。
	// 续约周期有 1s 下限，这条性质无法用注入时钟断言，只能等真实时间。
	it("renews the record so a long-lived holder is never reclaimed as stale", async () => {
		const options = { timeoutMs: 0, ttlMs: 2000 };
		await withLock(lockPath, "long", options, async () => {
			await new Promise((resolve) => setTimeout(resolve, 2500));
			const holder = JSON.parse(await readFile(lockPath, "utf8")) as LockInfo;
			expect(holder.pid).toBe(process.pid);
			expect(holder.op).toBe("long");
			// startedAt 已被心跳推后 → 用真实时钟看它不老于 TTL
			expect(Date.now() - Date.parse(holder.startedAt)).toBeLessThan(options.ttlMs);
			// 因此另一个写者判定它不 stale，抢不到锁（未续约时这里会删锁并返回 "stolen"）
			await expect(withLock(lockPath, "thief", options, async () => "stolen")).rejects.toThrow(
				MemoryLockedError,
			);
		});
	}, 15_000);

	// 释放必须校验所有权：锁被别人接管后（stale 误判 / 人工干预），无条件 rm 会删掉别人的锁，
	// 对方的 finally 再删掉第三个写者的锁 —— 与已被修掉的空文件窗口同类级联失效。
	it("does not delete a lock that another process now owns", async () => {
		await withLock(lockPath, "mine", { timeoutMs: 0, ttlMs: 60_000 }, async () => {
			// 持有期间把锁文件换成别人的记录（ttl 60s → 心跳周期 30s，本用例内不会触发续约）
			await writeLock({ pid: process.pid + 1, op: "thief" });
		});
		const holder = JSON.parse(await readFile(lockPath, "utf8")) as LockInfo;
		expect(holder.op).toBe("thief");
		expect(holder.pid).toBe(process.pid + 1);
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
