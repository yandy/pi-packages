import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join, normalize, resolve, sep } from "node:path";
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

const DIR_NAME_MAX = 120;
const DIR_NAME_KEEP = 100;
const HASH_LENGTH = 8;
const ILLEGAL_SEGMENT_CHARS = /[<>:"|?*\x00-\x1f]/g;

/** Escape characters that are unsafe in a single filesystem path segment. */
function escapeSegment(segment: string): string {
	return segment.replace(ILLEGAL_SEGMENT_CHARS, (ch) => `_${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * Encode a project key into a single, human-readable directory name.
 * `host/repo/path` → `host__repo__path`; `/abs/path` → `abs__path`.
 */
export function projectDirName(key: string): string {
	const segments = key
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment !== "" && segment !== "." && segment !== "..")
		.map(escapeSegment);
	if (segments.length === 0) return "root";
	const joined = segments.join("__");
	if (joined.length <= DIR_NAME_MAX) return joined;
	const suffix = createHash("sha256").update(key).digest("hex").slice(0, HASH_LENGTH);
	return `${joined.slice(0, DIR_NAME_KEEP)}__${suffix}`;
}

export async function projectHash(cwd: string): Promise<string> {
	const key = (await gitToplevel(cwd)) ?? resolve(cwd);
	return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export async function resolveMemoryDir(config: { memoryDir: string }, cwd: string): Promise<string> {
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
