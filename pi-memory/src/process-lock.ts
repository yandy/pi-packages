/**
 * 进程内互斥（**不跨进程**）。
 *
 * 为什么存在：`memory add`、extract、dream 都在**同一个 pi 进程**里（dream 与 extract 是
 * 进程内的 SDK 会话，不是子进程），而它们的互斥作用域长度相差三个数量级 —— 单次写入是毫秒，
 * dream 整轮是分钟。让一把**跨进程**的 `.lock` 同时承担这两段时长会引出两串麻烦：
 *   1. dream 整轮持 `.lock` 时，它自己的每次原语调用都会撞上自己的锁（`.lock` 不可重入）；
 *   2. 另一个 pi 进程（同仓库的多个 worktree 共享 memory 目录）的写入要被堵住整轮；
 *   3. 「持锁数分钟」逼出了 TTL 续约心跳与 stale 接管，而后者在 POSIX 上没有
 *      compare-and-replace，无法做到可证明安全（见 fs-lock.ts 的说明）。
 *
 * 所以分层：**本模块承担「逻辑作用域」（毫秒的单次调用 或 分钟的整轮），
 * `.lock` 只承担毫秒级的物理写入。** 进程内互斥是一个 Promise 队列 —— 天然可嵌套地表达
 * 「谁在等谁」，零文件系统、零 staleness、零平台语义。
 */

/** 等待超过 `timeoutMs` 仍未拿到锁。调用方应把它当作可向用户交代的明确失败，而不是可重试的抖动。 */
export class ProcessLockTimeoutError extends Error {
	constructor(
		readonly key: string,
		readonly timeoutMs: number,
	) {
		super(`Memory operations for ${key} are already running in this process (waited ${timeoutMs}ms)`);
		this.name = "ProcessLockTimeoutError";
	}
}

/** 每个 key 的状态。**永不删除** —— 删了会出现「同一 key 两套状态」的脑裂互斥（一方用旧状态、一方用新状态）。条目数 = 进程见过的 memoryDir 数，可忽略。 */
interface LockState {
	/** 队尾：最后一个等待者放行后 resolve 的 promise。 */
	tail: Promise<void>;
	/** 当前是否有人持有。仅用于诊断/断言 —— 互斥本身依赖 `tail`，不依赖它。 */
	held: boolean;
	/** 正在排队（尚未拿到）的调用数。 */
	waiters: number;
}

const states = new Map<string, LockState>();

function stateFor(key: string): LockState {
	let state = states.get(key);
	if (!state) {
		state = { tail: Promise.resolve(), held: false, waiters: 0 };
		states.set(key, state);
	}
	return state;
}

/**
 * 排队取得某个 key 的进程内锁，返回释放函数。
 *
 * 超时时**必须把自己的 gate 放掉**：我们从未持有过锁，若不放行，排在后面的调用会被我们的 gate
 * 永久挂住（队尾链是 `previous.then(() => gate)`，我们的 gate 不放，后面所有人都拿不到）。
 *
 * 注意：**不能用「队尾是否为空」当作「有没有被持有」** —— 等待者超时会把自己从队尾摘掉，
 * 而持有者仍在工作，于是队尾变空而锁定仍被持有。所以 `held` / `waiters` 单独计数。
 */
async function acquire(key: string, timeoutMs: number): Promise<() => void> {
	const state = stateFor(key);
	const previous = state.tail;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	state.tail = previous.then(() => gate, () => gate);
	state.waiters += 1;

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = Symbol("timeout");
	const outcome = await Promise.race([
		previous.then(() => "acquired" as const),
		new Promise<typeof timedOut>((resolve) => {
			timer = setTimeout(() => resolve(timedOut), timeoutMs);
		}),
	]);
	if (timer) clearTimeout(timer);
	state.waiters -= 1;

	if (outcome === timedOut) {
		release();
		throw new ProcessLockTimeoutError(key, timeoutMs);
	}

	state.held = true;
	return () => {
		state.held = false;
		release();
	};
}

/** 在进程内串行执行 `fn`（按 `key` 分键）。超时抛 `ProcessLockTimeoutError`。 */
export async function withProcessLock<T>(key: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
	const release = await acquire(key, timeoutMs);
	try {
		return await fn();
	} finally {
		release();
	}
}

/** 只在 `key` 空闲时执行 `fn`；有人在持有或排队则立刻返回 `null`，绝不等待（extract 的「锁忙则跳过本轮」）。 */
export async function tryWithProcessLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
	try {
		return await withProcessLock(key, 0, fn);
	} catch (e) {
		if (e instanceof ProcessLockTimeoutError) return null;
		throw e;
	}
}

/**
 * 该 key 上是否有人在持有或排队。
 * 用途：整轮持有者（dream / 迁移）启动前断言自己确实已经包住了锁 —— 「忘了包」会静默失去整轮互斥，
 * 这条断言把它变成一个立刻可见的错误。
 *
 * 注意它只是**诊断用**的：互斥由 `tail` 保证。释放与下一个持有者接上之间存在一个微任务窗口，
 * 此窗口内 `isProcessLockActive` 可能瞬时返回 false，但那时新调用者仍然会正确地排在 `tail` 之后。
 */
export function isProcessLockActive(key: string): boolean {
	const state = states.get(key);
	return state !== undefined && (state.held || state.waiters > 0);
}
