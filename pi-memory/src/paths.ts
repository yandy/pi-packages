import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const GIT_TIMEOUT_MS = 3000;

async function gitToplevel(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileP("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: GIT_TIMEOUT_MS });
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

const DIR_NAME_MAX_BYTES = 120;
const DIR_NAME_KEEP_BYTES = 100;
const HASH_LENGTH = 8;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching C0 control characters for path escaping
const ILLEGAL_SEGMENT_CHARS = /[<>:"|?*\x00-\x1f]/g;

/** Escape characters that are unsafe in a single filesystem path segment. */
function escapeSegment(segment: string): string {
	return segment.replace(ILLEGAL_SEGMENT_CHARS, (ch) => `_${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateToBytes(input: string, maxBytes: number): string {
	let kept = "";
	for (const ch of input) {
		if (Buffer.byteLength(kept + ch, "utf8") > maxBytes) break;
		kept += ch;
	}
	return kept;
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
	// Filesystems cap one name at 255 bytes: count bytes so multi-byte names
	// (CJK, emoji) cannot exceed the limit, and cut on code point boundaries.
	if (Buffer.byteLength(joined, "utf8") <= DIR_NAME_MAX_BYTES) return joined;
	const suffix = createHash("sha256").update(key).digest("hex").slice(0, HASH_LENGTH);
	return `${truncateToBytes(joined, DIR_NAME_KEEP_BYTES)}__${suffix}`;
}

export type ProjectKind = "git" | "local";

export interface ProjectIdentity {
	kind: ProjectKind;
	/** git: normalized remote as `host/path`; local: absolute project root */
	key: string;
}

const GIT_PROTOCOLS = new Set(["http", "https", "ssh", "git"]);
const SCHEME_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Normalize an http(s)/ssh/git remote URL to `host/path`.
 * Accepts `[user@]host:path` scp syntax and `git+ssh` / `git+https` aliases.
 * Returns null for file:// URLs, local paths and URLs without a repository path.
 */
export function normalizeRemoteUrl(url: string): string | null {
	const raw = url.trim();
	if (!raw) return null;

	let host: string;
	let path: string;
	if (SCHEME_URL.test(raw)) {
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			return null;
		}
		const scheme = parsed.protocol.slice(0, -1).toLowerCase().replace(/^git\+/, "");
		if (!GIT_PROTOCOLS.has(scheme)) return null;
		host = parsed.hostname;
		path = parsed.pathname;
	} else {
		// scp-style `[user@]host:path` — git-specific syntax, no stdlib parser.
		const colon = raw.indexOf(":");
		if (colon === -1) return null;
		const authority = raw.slice(0, colon);
		if (!authority || authority.includes("/")) return null;
		const at = authority.lastIndexOf("@");
		host = at === -1 ? authority : authority.slice(at + 1);
		path = raw.slice(colon + 1);
	}

	if (!host) return null;
	path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
	if (!path) return null;
	return `${host.toLowerCase()}/${path}`;
}

async function gitRemoteUrl(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileP("git", ["remote", "get-url", "origin"], { cwd, timeout: GIT_TIMEOUT_MS });
		const url = stdout.trim();
		if (url) return url;
	} catch {
		// origin missing or without URL — fall through to the remote list
	}
	try {
		const { stdout } = await execFileP("git", ["remote"], { cwd, timeout: GIT_TIMEOUT_MS });
		const names = stdout
			.split("\n")
			.map((name) => name.trim())
			.filter(Boolean)
			.sort();
		for (const name of names) {
			try {
				const { stdout: remoteOut } = await execFileP("git", ["remote", "get-url", name], {
					cwd,
					timeout: GIT_TIMEOUT_MS,
				});
				const url = remoteOut.trim();
				if (url) return url;
			} catch {
				// try the next remote
			}
		}
	} catch {
		// no remotes at all
	}
	return null;
}

/** Resolve the project identity: normalized git remote, or the project root path. */
export async function projectIdentity(cwd: string): Promise<ProjectIdentity> {
	const toplevel = await gitToplevel(cwd);
	if (!toplevel) return { kind: "local", key: resolve(cwd) };
	const remote = await gitRemoteUrl(cwd);
	const key = remote ? normalizeRemoteUrl(remote) : null;
	if (key) return { kind: "git", key };
	return { kind: "local", key: resolve(toplevel) };
}

export async function resolveMemoryDir(config: { memoryDir: string }, cwd: string): Promise<string> {
	const { kind, key } = await projectIdentity(cwd);
	return join(config.memoryDir, kind, projectDirName(key));
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
