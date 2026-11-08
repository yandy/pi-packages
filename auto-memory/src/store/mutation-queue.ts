import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 按文件串行的进程内变更队列。
 *
 * 语义与 pi 的 `withFileMutationQueue`（`@earendil-works/pi-coding-agent` 的
 * `core/tools/file-mutation-queue`）逐条一致 —— `MemoryStore` 的每一次写入都要经过它，
 * 任何偏差都会以「同一目录两条并行写入链」的形式在并发下静默出现，因此这里刻意不做简化：
 *
 * 1. **key 由路径派生，不是调用方给的字符串**：`resolve()` 之后再 `realpath()`，于是同一文件的
 *    绝对路径、相对路径、以及指向它的 symlink 都落到同一条队列上（`~/.local/share` 是符号链接、
 *    macOS 的 `/tmp` → `/private/tmp` 都属这种情况）。
 * 2. **`realpath` 失败要分情况**：目标还不存在（`ENOENT`）或路径穿过一个普通文件（`ENOTDIR`）
 *    是常态 —— 索引文件在第一次写入前就是不存在 —— 此时回落到 `resolve()` 的结果；其余错误
 *    （权限等）**上抛**，不静默降级成一条按拼写分叉的队列。
 * 3. **key 的派生本身串行**：`realpath` 是异步的，两个并发调用若各自派生，谁先 `map.set` 就不确定了。
 *    `registrationQueue` 把派生排队，于是「注册顺序 = 执行顺序」，与调用方发起的先后一致。
 * 4. **失败不毒化队列**：链上挂的是 `nextQueue`（只在 `finally` 里 resolve，永不 reject），
 *    `fn` 的异常沿自己的返回路径冒给调用方，后继调用照常执行。
 */
const fileMutationQueues = new Map<string, Promise<void>>();

let registrationQueue: Promise<void> = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		((error as { code?: string }).code === "ENOENT" || (error as { code?: string }).code === "ENOTDIR")
	);
}

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	try {
		return await realpath(resolvedPath);
	} catch (error) {
		if (isMissingPathError(error)) {
			return resolvedPath;
		}
		throw error;
	}
}

interface Registration {
	key: string;
	/** 本次调用要等的前驱链尾。 */
	currentQueue: Promise<void>;
	/** 本次调用挂进 map 的新链尾，供 `finally` 判断自己是否仍是最后一个。 */
	chainedQueue: Promise<void>;
	releaseNext: () => void;
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration: Promise<Registration> = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);
		return { key, currentQueue, chainedQueue, releaseNext };
	});
	// 两个分支都吞掉结果：注册链只负责排序，`registration` 自己的异常由下面的 await 冒给调用方。
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		// 只有自己仍是链尾时才删：后继已经把自己接上时，删掉会让第三个调用者拿到空队列从而并行。
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
