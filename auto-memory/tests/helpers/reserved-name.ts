import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const IS_WIN32_HOST = process.platform === "win32";

/**
 * Windows 保留设备名文件（con.md 等）在 win32 宿主上必须经 \\?\ 前缀路径操作：
 * 普通路径会被 Windows 规范化解析到设备（CON 等），创建/删除都会失败。
 * \\?\ 要求绝对路径且为反斜杠分隔。POSIX 上保留名只是普通文件名，走普通路径。
 */
function extendedPath(p: string): string {
	return `\\\\?\\${resolve(p)}`;
}

export async function createReservedNameFixture(dir: string, name: string, content: string): Promise<void> {
	const path = resolve(dir, name);
	await writeFile(IS_WIN32_HOST ? extendedPath(path) : path, content, "utf8");
}

export async function removeReservedNameFixture(dir: string, name: string): Promise<void> {
	const path = resolve(dir, name);
	await rm(IS_WIN32_HOST ? extendedPath(path) : path, { force: true });
}
