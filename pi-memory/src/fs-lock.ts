import { link, open, readFile, rm, unlink } from "node:fs/promises";
import { hostname } from "node:os";

export interface LockInfo {
	pid: number;
	hostname: string;
	startedAt: string;
	op: string;
}

export interface LockOptions {
	timeoutMs: number;
	ttlMs: number;
	pollMs?: number;
	now?: () => number;
}

export class MemoryLockedError extends Error {
	constructor(
		readonly holder: LockInfo | null,
		readonly op: string,
	) {
		super(
			`Memory is locked by ${holder?.op ?? "unknown"} (pid ${holder?.pid ?? "?"}, started ${holder?.startedAt ?? "?"})`,
		);
		this.name = "MemoryLockedError";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// 只有 ESRCH（无此进程）才算死亡。EPERM 是「存在但无权限发信号」；其它意外 errno 一并按存活处理 ——
		// 对互斥而言，「误判为存活」最多等到 TTL 兜底，「误判为死亡」却会删掉别人的锁、让两个写者同时进入临界区。
		return (e as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function isLockInfo(value: unknown): value is LockInfo {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.pid === "number" &&
		Number.isFinite(record.pid) &&
		typeof record.hostname === "string" &&
		typeof record.startedAt === "string" &&
		typeof record.op === "string"
	);
}

/**
 * 读取锁的持有者。返回 null 表示「无法解释的锁」→ 上层按 stale 回收。
 * 必须做形状校验：合法 JSON 但不是锁记录（`123`、`{}`、未来 schema）若原样返回，
 * `isStale` 会因为 hostname 不是字符串而跳过 pid 检查、又因为 `Date.parse(undefined)` 是 NaN
 * 而跳过 TTL 检查，于是这个锁**永远不会**变 stale —— 调用方会永远超时。
 */
async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
		return isLockInfo(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

let tempCounter = 0;

/**
 * 原子获取：先把持有者信息写进同目录的唯一临时文件，再 `link` 到锁路径。
 *
 * 不能用 `open(lockPath, "wx")` 后紧接着单独写内容 —— 那会让锁路径出现「存在但 0 字节」的
 * 中间态，而 `readLockInfo` 读到空文件会返回 null、`isStale(null)` 恒为 true（pid 与 TTL
 * 检查根本不会执行）。并发等待者恰好采样到这个窗口就会**删掉刚被正确获取的锁**并据为己有，
 * 于是两个写者同时进入临界区 —— 正是本模块要防止的失效。link 是原子的：锁路径要么不存在，
 * 要么内容是完整的 JSON。
 */
async function writeExclusive(lockPath: string, info: LockInfo): Promise<boolean> {
	tempCounter += 1;
	const tempPath = `${lockPath}.${process.pid}.${tempCounter}.tmp`;
	try {
		const handle = await open(tempPath, "wx");
		try {
			await handle.writeFile(JSON.stringify(info), "utf8");
		} finally {
			await handle.close();
		}
		try {
			await link(tempPath, lockPath);
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw e;
		}
	} finally {
		await unlink(tempPath).catch(() => {});
	}
}

function isStale(holder: LockInfo | null, ttlMs: number, now: number): boolean {
	if (holder === null) return true;
	if (holder.hostname === hostname() && !isProcessAlive(holder.pid)) return true;
	const started = Date.parse(holder.startedAt);
	return Number.isFinite(started) && now - started > ttlMs;
}

/** 尝试获取一次（含 stale 回收，stale 只重试一次）。 */
async function attempt(
	lockPath: string,
	info: LockInfo,
	ttlMs: number,
	now: number,
): Promise<{ acquired: boolean; holder: LockInfo | null }> {
	if (await writeExclusive(lockPath, info)) return { acquired: true, holder: null };
	const holder = await readLockInfo(lockPath);
	if (!isStale(holder, ttlMs, now)) return { acquired: false, holder };
	await rm(lockPath, { force: true });
	if (await writeExclusive(lockPath, info)) return { acquired: true, holder: null };
	return { acquired: false, holder: await readLockInfo(lockPath) };
}

function holderInfo(op: string, now: number): LockInfo {
	return { pid: process.pid, hostname: hostname(), startedAt: new Date(now).toISOString(), op };
}

/** 等待获取锁（轮询 pollMs，默认 50ms）；超时抛 MemoryLockedError。 */
export async function withLock<T>(
	lockPath: string,
	op: string,
	options: LockOptions,
	fn: () => Promise<T>,
): Promise<T> {
	const clock = options.now ?? Date.now;
	const info = holderInfo(op, clock());
	const deadline = clock() + options.timeoutMs;

	let last: LockInfo | null = null;
	for (;;) {
		const result = await attempt(lockPath, info, options.ttlMs, clock());
		if (result.acquired) break;
		last = result.holder;
		if (clock() >= deadline) throw new MemoryLockedError(last, op);
		await sleep(options.pollMs ?? 50);
	}

	try {
		return await fn();
	} finally {
		await rm(lockPath, { force: true });
	}
}

/** 只尝试一次；锁被活进程持有时返回 null，不等待。 */
export async function tryWithLock<T>(
	lockPath: string,
	op: string,
	options: LockOptions,
	fn: () => Promise<T>,
): Promise<T | null> {
	const clock = options.now ?? Date.now;
	const result = await attempt(lockPath, holderInfo(op, clock()), options.ttlMs, clock());
	if (!result.acquired) return null;
	try {
		return await fn();
	} finally {
		await rm(lockPath, { force: true });
	}
}
