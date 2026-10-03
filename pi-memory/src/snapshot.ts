import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { withFsRetry } from "./fs-retry";

export interface SnapshotOptions {
	keep: number;
	now?: () => Date;
	/** 重试判定跟随的平台（默认 `process.platform`）：win32 才把 EPERM/EACCES 当瞬时错误。 */
	platform?: NodeJS.Platform;
}

/**
 * 只包住**幂等**的物理调用（`mkdir` 是 `recursive` 的、`cp` 会覆盖），因此重试不会产生副作用。
 * 快照跑在**每一次**写入原语里（memory-store 的 `#maybeSnapshot`，已在跨进程锁之内），而
 * Windows 上杀软扫描与同步客户端打断的正是 `mkdir`/`cp` 这类调用：不重试的话，一次瞬时
 * EPERM 就会让 `memory add` 直接失败（spec §1.2 P5）。
 */
function withSnapshotRetry<T>(fn: () => Promise<T>, platform?: NodeJS.Platform): Promise<T> {
	return withFsRetry(fn, { platform });
}

/** 可字典序排序的快照时间戳（ISO 8601，`:` 与 `.` 换为 `-`）。 */
export function snapshotStamp(now: () => Date): string {
	return now().toISOString().replace(/[:.]/g, "-");
}

async function uniqueDir(backupRoot: string, base: string, platform?: NodeJS.Platform): Promise<string> {
	await withSnapshotRetry(() => mkdir(backupRoot, { recursive: true }), platform);
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? join(backupRoot, base) : join(backupRoot, `${base}-${n}`);
		try {
			await withSnapshotRetry(() => mkdir(candidate), platform);
			return candidate;
		} catch (e) {
			// EEXIST 仍然是「换下一个名字」的信号：它不在 `withFsRetry` 的瞬时错误集合里，
			// 重试不会吞掉它（重名快照的用例靠这一行）。
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
	}
}

/** 将给定的 memory 目录相对路径复制到新快照目录；不存在的文件被跳过。 */
export async function createSnapshot(
	backupRoot: string,
	label: string,
	files: string[],
	memoryDir: string,
	options: SnapshotOptions,
): Promise<string> {
	const dir = await uniqueDir(
		backupRoot,
		`${snapshotStamp(options.now ?? (() => new Date()))}-${label}`,
		options.platform,
	);
	for (const file of files) {
		try {
			await withSnapshotRetry(() => cp(join(memoryDir, file), join(dir, basename(file))), options.platform);
		} catch (e) {
			// ENOENT（条目文件还不存在）同样不在重试集合里：跳过行为不变。
			if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw e;
		}
	}
	await pruneSnapshots(backupRoot, options.keep);
	return dir;
}

/** 保留名字序最新的 keep 个快照；`migrate-` 开头的目录永不参与裁剪。 */
export async function pruneSnapshots(backupRoot: string, keep: number): Promise<void> {
	let names: string[];
	try {
		names = await readdir(backupRoot);
	} catch {
		return;
	}

	const dirs: string[] = [];
	for (const name of names) {
		if (name.startsWith("migrate-")) continue;
		const info = await stat(join(backupRoot, name)).catch(() => null);
		if (info?.isDirectory()) dirs.push(name);
	}

	dirs.sort();
	for (const name of dirs.slice(0, Math.max(0, dirs.length - Math.max(0, keep)))) {
		// 删目录会被杀软/索引器打成瞬时 EPERM/EBUSY：用 Node 自带的退避重试。
		// 这两个参数**不是 Windows 专属**（Linux 上实测：`maxRetries: 3, retryDelay: 300`
		// 会把一个 EMFILE 重试三次），因此全平台都生效。
		await rm(join(backupRoot, name), { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
	}
}
