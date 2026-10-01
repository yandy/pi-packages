import { open, readFile, rm } from "node:fs/promises";
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
		// EPERM 说明进程存在但没有权限发信号，仍视为存活。
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		return JSON.parse(await readFile(lockPath, "utf8")) as LockInfo;
	} catch {
		return null;
	}
}

async function writeExclusive(lockPath: string, info: LockInfo): Promise<boolean> {
	try {
		const handle = await open(lockPath, "wx");
		try {
			await handle.writeFile(JSON.stringify(info), "utf8");
		} finally {
			await handle.close();
		}
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw e;
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
	op: string,
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
		const result = await attempt(lockPath, op, info, options.ttlMs, clock());
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
	const result = await attempt(lockPath, op, holderInfo(op, clock()), options.ttlMs, clock());
	if (!result.acquired) return null;
	try {
		return await fn();
	} finally {
		await rm(lockPath, { force: true });
	}
}
