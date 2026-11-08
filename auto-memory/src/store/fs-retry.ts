import { setTimeout as sleep } from "node:timers/promises";

/**
 * 物理文件系统调用的短退避重试。存在理由（spec §1.2 P5）：Windows 上杀软扫描、索引器、
 * 编辑器会用瞬时 `EPERM`/`EBUSY` 打断正常写入；而 pi-memory 是 fail-closed 且锁永不自动回收 ——
 * 一次瞬时错误若落在释放锁的 `rm(.lock)` 上，就会留下一个只能人工 `/memory unlock` 的锁，
 * 之后该项目**所有**记忆写入被堵死。
 */

/** 全平台都算瞬时：这些 errno 在 POSIX 上同样是可恢复的争用（对齐 Node `fs.rm` 的重试集合）。 */
const TRANSIENT_CODES = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY"]);
/** 只在 win32 追加：POSIX 上 EPERM/EACCES 是永久性权限错误，重试只会拖慢 fail-closed。 */
const WINDOWS_ONLY_CODES = new Set(["EPERM", "EACCES"]);

export function isTransientFsError(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
	const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
	if (typeof code !== "string") return false;
	if (TRANSIENT_CODES.has(code)) return true;
	return platform === "win32" && WINDOWS_ONLY_CODES.has(code);
}

export interface FsRetryOptions {
	retries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	platform?: NodeJS.Platform;
	/** 测试注入缝：替换真实等待。 */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * 重试 `fn` 直到成功、遇到非瞬时错误、或耗尽预算。
 * **错过的错误原样上抛**（含耗尽后的最后一次）—— 调用方的 fail-closed 语义与错误文案都不变
 * （spec Ruling 8），这里不包装新错误类型。
 */
export async function withFsRetry<T>(fn: () => Promise<T>, options: FsRetryOptions = {}): Promise<T> {
	const retries = options.retries ?? 6;
	const baseDelayMs = options.baseDelayMs ?? 20;
	const maxDelayMs = options.maxDelayMs ?? 300;
	const platform = options.platform ?? process.platform;
	const wait = options.sleep ?? ((ms: number) => sleep(ms));

	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (e) {
			if (attempt >= retries || !isTransientFsError(e, platform)) throw e;
			await wait(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
		}
	}
}
