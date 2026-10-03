import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export interface SnapshotOptions {
	keep: number;
	now?: () => Date;
}

/** 可字典序排序的快照时间戳（ISO 8601，`:` 与 `.` 换为 `-`）。 */
export function snapshotStamp(now: () => Date): string {
	return now().toISOString().replace(/[:.]/g, "-");
}

async function uniqueDir(backupRoot: string, base: string): Promise<string> {
	await mkdir(backupRoot, { recursive: true });
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? join(backupRoot, base) : join(backupRoot, `${base}-${n}`);
		try {
			await mkdir(candidate);
			return candidate;
		} catch (e) {
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
	const dir = await uniqueDir(backupRoot, `${snapshotStamp(options.now ?? (() => new Date()))}-${label}`);
	for (const file of files) {
		try {
			await cp(join(memoryDir, file), join(dir, basename(file)));
		} catch (e) {
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
		// Windows 上删目录会被杀软/索引器打成瞬时 EPERM/EBUSY：用 Node 自带的退避重试
		// （非 Windows 平台会忽略这两个参数）。
		await rm(join(backupRoot, name), { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
	}
}
