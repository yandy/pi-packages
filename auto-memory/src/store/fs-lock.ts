import { open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { withFsRetry } from "./fs-retry";

/**
 * **跨进程**锁。只保护「毫秒级的物理写入」这一件事。
 *
 * 作用域分工（见 process-lock.ts 的说明）：进程内的**逻辑作用域**（单次调用、dream 整轮）由
 * `process-lock.ts` 的 Promise 队列承担，因此这里永远只被持有一瞬间 —— 不存在「持有太久」，
 * 也就不需要 TTL、续约心跳与存活探测。
 *
 * **永不自动回收**：另一个进程崩溃留下的锁没有任何人能释放它，但**也不会被自动删掉**。
 * 原因是「移走别人的锁」无法用 POSIX 原语做到可证明安全（Windows 同样没有 compare-and-delete
 * 原语）：锁路径不存在（`open(wx)`）正是
 * 合法获取条件，所以任何「先移走旧锁、再建立自己的」的接管都会产生一个空窗，其它等待者
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
				: holder
					? `Memory is locked by ${described}`
					: `Memory lock at ${lockPath} is still being written (0 bytes) — if no other process is writing, delete the file or run /memory unlock`,
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
	/** 存在且 0 字节：持有者刚建立文件、记录还没写完（或恰好崩溃在这一瞬间）。 */
	| { kind: "empty" }
	/** 存在但无法解释（非 JSON、空文件之外的坏内容、形状不对、读不到）：只有人工能清除它。 */
	| { kind: "unreadable" }
	| { kind: "held"; holder: LockInfo };

/**
 * 读锁的状态。**必须区分「不存在」与「存在但读不懂」** —— 把前者当成后者会让
 * 「持有者刚释放、锁刚被删」被误报成「遗弃的锁」，从而在正常竞争下抛出误导性的错误。
 *
 * 自 `open(wx)` 原语起还多一态 `empty`：锁文件建立与记录写入之间有一个极短窗口（spec §4.4），
 * 它必须与「读不懂」分开 —— 否则等待者会把「别人正在建锁」误报成「遗弃的锁」并立刻失败。
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
	// 0 字节是**正常的中间态**：`open(wx)` 建立文件与写入记录之间有一个极短窗口（spec §4.4）。
	// 它必须与「读不懂」分开 —— 否则等待者会把「别人正在建锁」误报成「遗弃的锁」并立刻失败。
	if (raw.length === 0) return { kind: "empty" };
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
 * **复用私有的 `readLockState`**，不另写一份读逻辑：状态必须与获取路径同源，
 * 否则会出现「`/memory` 说 free，下一次写入却报 locked」这种无法诊断的矛盾。
 * 对外只暴露三态：`empty`（建立中的 0 字节记录）归入 `unreadable` —— 对人类观察者而言
 * 它只可能是崩溃残留，处置方式与「读不懂」相同（`/memory unlock`）。
 * 它**不判断存活、也不删任何东西**（永不自动回收）；持有者是否已死由调用方自己看 pid。
 */
export async function readLockStatus(
	lockPath: string,
): Promise<{ kind: "absent" } | { kind: "unreadable" } | { kind: "held"; holder: LockInfo }> {
	const state = await readLockState(lockPath);
	return state.kind === "empty" ? { kind: "unreadable" } : state;
}

type AcquireOutcome =
	| { acquired: true }
	| { acquired: false; holder: LockInfo | null; abandoned: boolean };

/**
 * 尝试一次获取。路径为空时不当作失败 —— 那是「刚好被释放」，直接再试一次 `open(wx)`（CAS 会自然地
 * 决出唯一赢家）；两次都撞上「刚好被释放」才交回给调用方重试。
 */
async function acquireOnce(lockPath: string, info: LockInfo): Promise<AcquireOutcome> {
	for (let round = 0; round < 2; round++) {
		if (await createExclusive(lockPath, info)) return { acquired: true };
		const state = await readLockState(lockPath);
		if (state.kind === "absent") continue;
		// 建立中：有人在写记录，等它写完（或超时）。**不是**遗弃。
		if (state.kind === "empty") return { acquired: false, holder: null, abandoned: false };
		if (state.kind === "unreadable") return { acquired: false, holder: null, abandoned: true };
		return { acquired: false, holder: state.holder, abandoned: isAbandoned(state.holder) };
	}
	return { acquired: false, holder: null, abandoned: false };
}

/**
 * 原子获取：`open(lockPath, "wx")`（POSIX 的 `O_CREAT|O_EXCL`、Windows 的 `CREATE_NEW`、
 * SMB2 的 `FILE_CREATE`）保证只有一个进程能建立锁文件，建立后**立即**写入完整的持有者记录。
 *
 * 与旧实现的差别：旧实现先把记录写进同目录的临时文件、再 `link` 到锁路径，因而内容原子出现；
 * 但 `link` **只支持 NTFS**（ReFS、部分网络共享与云盘目录都不支持），在那些卷上整把锁取不到
 * → 记忆完全不可写（spec §1.2 P4）。`open(wx)` 的**建立**在任意卷上都原子 —— 原子的只是
 * 「谁建了这个文件」，**不是记录内容**：内容随后才写，于是有「文件已建立、内容未写入」的极短
 * 窗口，由读取侧的 `empty` 态与 `/memory unlock` 兜底（spec §4.4）。
 */
async function createExclusive(lockPath: string, info: LockInfo): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await withFsRetry(() => open(lockPath, "wx"));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw e;
	}
	try {
		const record = Buffer.from(JSON.stringify(info), "utf8");
		await withFsRetry(async () => {
			// 定长位置写 + 完整性校验：写入用显式偏移，重试不会续写（`writeFile` 会把第二次写入
			// 追加到当前位置 → 两个 JSON 拼接 → 读者判 unreadable → 持有者自己也释放不掉这把锁）。
			let written = 0;
			while (written < record.length) {
				const { bytesWritten } = await handle.write(record, written, record.length - written, written);
				if (bytesWritten <= 0) {
					throw Object.assign(new Error("lock record write made no progress"), { code: "EIO" });
				}
				written += bytesWritten;
			}
		});
		// `close` 也可能失败（SMB/网络盘的延迟刷写错误、EIO），而它在记录**已落盘**之后发生：
		// 若直接上抛，`withLock` 的 finally 不会执行（acquire 从未返回 true），锁会留在原地并指向
		// 本进程 → 本进程此后每次获取都读到「活持有者」并自锁到 timeout。故与写入失败同一处置。
		await handle.close();
	} catch (e) {
		// 走到这里说明这把锁没有可用的持有者（记录没写进去，或 close 失败）：先关句柄再删文件
		// （Windows 上删除打开中的文件需要 share-delete，且删除会延迟到关闭之后），否则会留下
		// 0 字节/自指的锁挡住后来的写入者。`rm` 走重试：win32 上杀软/索引器造成的瞬时 EPERM
		// 正是本任务要消掉的那类残留（spec §1.2 P5）。
		await handle.close().catch(() => {});
		await withFsRetry(() => rm(lockPath, { force: true })).catch(() => {});
		throw e;
	}
	return true;
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
 * 记录读不懂或仍是 0 字节（建立中）时也**不删** —— 那是别人的状态（或需要人工处理的状态），
 * 不该由我们清理 —— 我们无法证明它属于自己（spec §4.4）。`force: true` 让「刚好被释放」不是错误。
 */
async function releaseLock(lockPath: string): Promise<void> {
	const state = await readLockState(lockPath);
	if (state.kind === "unreadable" || state.kind === "empty") return;
	if (state.kind === "held" && !isOwnRecord(state.holder)) return;
	await withFsRetry(() => rm(lockPath, { force: true }));
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
