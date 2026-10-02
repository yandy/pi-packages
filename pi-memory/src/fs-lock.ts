import { link, open, readFile, rm, unlink } from "node:fs/promises";
import { hostname } from "node:os";

/**
 * **跨进程**锁。只保护「毫秒级的物理写入」这一件事。
 *
 * 作用域分工（见 process-lock.ts 的说明）：进程内的**逻辑作用域**（单次调用、dream 整轮）由
 * `process-lock.ts` 的 Promise 队列承担，因此这里永远只被持有一瞬间 —— 不存在「持有太久」，
 * 也就不需要 TTL、续约心跳与存活探测。
 *
 * **永不自动回收**：另一个进程崩溃留下的锁没有任何人能释放它，但**也不会被自动删掉**。
 * 原因是「移走别人的锁」无法用 POSIX 原语做到可证明安全：`link` 这个合法获取原语的条件正是
 * 「锁路径不存在」，所以任何「先移走旧锁、再建立自己的」的接管都会产生一个空窗，其它等待者
 * 可以合法地抢占它；一旦移走的其实是某个**活持有者**刚建立的记录，互斥就无法再恢复（把记录
 * 挪回去又会顶掉抢占者，而路径只能容纳一条记录）。实测：把 `rm` 换成原子 `rename` 仍然会双持有，
 * 加上「比字节 + 放回」则会把空窗拉长，同进程内可稳定复现双持有。
 *
 * 因此这里的策略是「安全优先」：崩溃遗留的锁**立刻**报一条可操作的错误（写明 pid / op /
 * startedAt / 路径，并提示如何清除），由人（或 Plan B 的显式 `/memory unlock`）处理。
 */
export interface LockInfo {
	pid: number;
	hostname: string;
	startedAt: string;
	op: string;
}

export interface LockOptions {
	timeoutMs: number;
	pollMs?: number;
	now?: () => number;
}

export class MemoryLockedError extends Error {
	constructor(
		readonly lockPath: string,
		readonly holder: LockInfo | null,
		readonly op: string,
		/** 记录指向一个已死的本机进程，或本身无法解释 —— 没有任何人会释放它，只能人工清除。 */
		readonly abandoned: boolean,
	) {
		const described = holder
			? `${holder.op} (pid ${holder.pid}, started ${holder.startedAt})`
			: "an unreadable record";
		super(
			abandoned
				? `Memory lock at ${lockPath} is abandoned by ${described} — delete the file to clear it`
				: `Memory is locked by ${described}`,
		);
		this.name = "MemoryLockedError";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 仅用于诊断（决定错误文案，不参与任何回收决策）。 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// 只有 ESRCH（无此进程）才算死亡；EPERM 是「存在但无权限发信号」，其余意外 errno 一并按存活处理。
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

type LockRead =
	/** 锁路径不存在 —— 这是「空闲」，不是「有问题」。 */
	| { kind: "absent" }
	/** 存在但无法解释（非 JSON、空文件、形状不对、读不到）：只有人工能清除它。 */
	| { kind: "unreadable" }
	| { kind: "held"; holder: LockInfo };

/**
 * 读锁的三种状态。**必须区分「不存在」与「存在但读不懂」** —— 把前者当成后者会让
 * 「持有者刚释放、锁刚被删」被误报成「遗弃的锁」，从而在正常竞争下抛出误导性的错误。
 */
async function readLockState(lockPath: string): Promise<LockRead> {
	let raw: string;
	try {
		raw = await readFile(lockPath, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		// 权限之类的错误：无法判断内容，按「读不懂」处理（不接管、报可操作错误）
		return { kind: "unreadable" };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return isLockInfo(parsed) ? { kind: "held", holder: parsed } : { kind: "unreadable" };
	} catch {
		return { kind: "unreadable" };
	}
}

/**
 * 锁的诊断视图（spec §14 的 `/memory`）。
 *
 * **复用私有的 `readLockState`**，不另写一份读逻辑：三态必须与获取路径同源，
 * 否则会出现「`/memory` 说 free，下一次写入却报 locked」这种无法诊断的矛盾。
 * 它**不判断存活、也不删任何东西**（永不自动回收）；持有者是否已死由调用方自己看 pid。
 */
export async function readLockStatus(
	lockPath: string,
): Promise<{ kind: "absent" } | { kind: "unreadable" } | { kind: "held"; holder: LockInfo }> {
	return readLockState(lockPath);
}

type AcquireOutcome =
	| { acquired: true }
	| { acquired: false; holder: LockInfo | null; abandoned: boolean };

/**
 * 尝试一次获取。路径为空时不当作失败 —— 那是「刚好被释放」，直接再试一次 link（CAS 会自然地
 * 决出唯一赢家）；两次都撞上「刚好被释放」才交回给调用方重试。
 */
async function acquireOnce(lockPath: string, info: LockInfo): Promise<AcquireOutcome> {
	for (let round = 0; round < 2; round++) {
		if (await writeExclusive(lockPath, info)) return { acquired: true };
		const state = await readLockState(lockPath);
		if (state.kind === "absent") continue;
		if (state.kind === "unreadable") return { acquired: false, holder: null, abandoned: true };
		return { acquired: false, holder: state.holder, abandoned: isAbandoned(state.holder) };
	}
	return { acquired: false, holder: null, abandoned: false };
}

let tempCounter = 0;

/**
 * 原子获取：先把持有者信息写进同目录的唯一临时文件，再 `link` 到锁路径。
 *
 * 不能用 `open(lockPath, "wx")` 后紧接着单独写内容 —— 那会让锁路径出现「存在但 0 字节」的
 * 中间态，等待者读到空文件会把它判为「无法解释」并据为己有。link 是原子的：锁路径要么不存在，
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

function holderInfo(op: string, now: number): LockInfo {
	return { pid: process.pid, hostname: hostname(), startedAt: new Date(now).toISOString(), op };
}

/**
 * 这把锁是否「已被遗弃」（没有任何人会释放它）。
 * - 记录无法解释：没有持有者能续约，也没人能释放 —— 遗弃。
 * - 同 host 且进程已死：持有者永远不会再释放它 —— 遗弃（这是唯一能确定的遗弃情形）。
 * - 跨 host：存活状况不可知 —— 一律按活持有者处理，绝不接管。
 */
function isAbandoned(holder: LockInfo | null): boolean {
	if (holder === null) return true;
	return holder.hostname === hostname() && !isProcessAlive(holder.pid);
}

/**
 * 只在锁仍是自己持有的情况下删除；否则留给真正的持有者。
 * 记录读不懂时也**不删** —— 那是别人的状态（或需要人工处理的状态），不该由我们清理。
 */
async function releaseLock(lockPath: string): Promise<void> {
	const state = await readLockState(lockPath);
	if (state.kind === "unreadable") return;
	if (state.kind === "held" && !isOwnRecord(state.holder)) return;
	await rm(lockPath, { force: true });
}

function isOwnRecord(holder: LockInfo): boolean {
	return holder.pid === process.pid && holder.hostname === hostname();
}

/** 等待获取锁（轮询 pollMs，默认 50ms）；超时或被遗弃时抛 MemoryLockedError。 */
export async function withLock<T>(
	lockPath: string,
	op: string,
	options: LockOptions,
	fn: () => Promise<T>,
): Promise<T> {
	const clock = options.now ?? Date.now;
	const info = holderInfo(op, clock());
	const deadline = clock() + options.timeoutMs;

	for (;;) {
		const outcome = await acquireOnce(lockPath, info);
		if (outcome.acquired) break;
		// 没人能释放它 → 等下去毫无意义；立刻给出可操作的错误，而不是耗满 timeout
		if (outcome.abandoned) throw new MemoryLockedError(lockPath, outcome.holder, op, true);
		if (clock() >= deadline) throw new MemoryLockedError(lockPath, outcome.holder, op, false);
		await sleep(options.pollMs ?? 50);
	}

	try {
		return await fn();
	} finally {
		await releaseLock(lockPath);
	}
}

/**
 * 只尝试一次，不等待。
 * 活持有者占用 → 返回 null（调用方跳过本轮）；被遗弃的锁 → **抛错而不是返回 null** ——
 * 它不会自愈，静默跳过只会让 extract 之类的后台任务永远不再运行且毫无提示。
 */
export async function tryWithLock<T>(
	lockPath: string,
	op: string,
	options: LockOptions,
	fn: () => Promise<T>,
): Promise<T | null> {
	const clock = options.now ?? Date.now;
	const outcome = await acquireOnce(lockPath, holderInfo(op, clock()));
	if (!outcome.acquired) {
		if (outcome.abandoned) throw new MemoryLockedError(lockPath, outcome.holder, op, true);
		return null;
	}
	try {
		return await fn();
	} finally {
		await releaseLock(lockPath);
	}
}
