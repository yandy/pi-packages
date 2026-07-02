import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { join, resolve, normalize, sep } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function gitToplevel(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileP("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3000 });
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

export async function projectHash(cwd: string): Promise<string> {
	const key = (await gitToplevel(cwd)) ?? resolve(cwd);
	return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export async function resolveMemoryDir(
	config: { memoryDir: string },
	cwd: string,
): Promise<string> {
	const hash = await projectHash(cwd);
	return join(config.memoryDir, hash);
}

export function safeTopicPath(memoryDir: string, topic: string): string {
	const normalized = normalize(topic);
	if (normalized.includes("..") || normalized.startsWith(sep)) {
		throw new Error(`Unsafe topic path: ${topic}`);
	}
	const resolved = resolve(memoryDir, normalized);
	const resolvedMemoryDir = resolve(memoryDir);
	if (!resolved.startsWith(resolvedMemoryDir + sep) && resolved !== resolvedMemoryDir) {
		throw new Error(`Topic escapes memory dir: ${topic}`);
	}
	return resolved;
}
