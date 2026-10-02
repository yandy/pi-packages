import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
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

/** Truncate to at most `maxBytes` UTF-8 bytes on grapheme-cluster boundaries. */
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

function truncateToBytes(input: string, maxBytes: number): string {
	let kept = "";
	for (const { segment } of GRAPHEME_SEGMENTER.segment(input)) {
		if (Buffer.byteLength(kept + segment, "utf8") > maxBytes) break;
		kept += segment;
	}
	return kept;
}

/**
 * Encode a project key into a single, human-readable directory name.
 * `host/repo/path` → `host__repo__path`; `/abs/path` → `abs__path`.
 * Naming targets POSIX filesystems: `\` is an ordinary character, without
 * Windows device-name or trailing-dot handling.
 */
export function projectDirName(key: string): string {
	const segments = key
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

/** Lowercase and IDN-normalize a host the way the URL API does for https. */
function normalizeHost(host: string): string {
	try {
		return new URL(`https://${host}`).hostname;
	} catch {
		return host.toLowerCase();
	}
}

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
		// Non-special schemes (ssh, git) keep an opaque, un-normalized host.
		host = normalizeHost(parsed.hostname);
		path = parsed.pathname;
	} else {
		// scp-style `[user@]host:path` — git-specific syntax, no stdlib parser.
		// Split at the first `:` outside a bracketed IPv6 literal.
		const open = raw.indexOf("[");
		const close = open === -1 ? -1 : raw.indexOf("]", open);
		if (open !== -1 && close === -1) return null;
		const colon = raw.indexOf(":", close === -1 ? 0 : close + 1);
		if (colon === -1) return null;
		const authority = raw.slice(0, colon);
		if (!authority || authority.includes("/")) return null;
		const at = authority.lastIndexOf("@");
		host = normalizeHost(at === -1 ? authority : authority.slice(at + 1));
		path = raw.slice(colon + 1);
	}

	if (!host) return null;
	path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
	if (!path) return null;
	return `${host}/${path}`;
}

interface RemoteEntry {
	name: string;
	url: string;
}

/**
 * Read every remote URL from the raw git config, in identity order:
 * `origin` first, then alphabetical. `url.*.insteadOf` rewrites do not apply here.
 */
async function gitRemoteUrls(cwd: string): Promise<RemoteEntry[]> {
	try {
		const { stdout } = await execFileP("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		});
		const byName = new Map<string, string>();
		for (const line of stdout.split("\n")) {
			const sep = line.indexOf(" ");
			if (sep === -1) continue;
			const key = line.slice(0, sep);
			if (!key.startsWith("remote.") || !key.endsWith(".url")) continue;
			const name = key.slice("remote.".length, -".url".length);
			const url = line.slice(sep + 1).trim();
			// First URL per remote wins, matching git's fetch-URL precedence.
			if (!name || !url || byName.has(name)) continue;
			byName.set(name, url);
		}
		const entries = [...byName].map(([name, url]) => ({ name, url }));
		entries.sort((a, b) => {
			if ((a.name === "origin") !== (b.name === "origin")) return a.name === "origin" ? -1 : 1;
			return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
		});
		return entries;
	} catch {
		return [];
	}
}

/** Resolve the project identity: normalized git remote, or the project root path. */
export async function projectIdentity(cwd: string): Promise<ProjectIdentity> {
	const toplevel = await gitToplevel(cwd);
	if (!toplevel) return { kind: "local", key: resolve(cwd) };
	for (const { url } of await gitRemoteUrls(cwd)) {
		const key = normalizeRemoteUrl(url);
		if (key) return { kind: "git", key };
	}
	return { kind: "local", key: resolve(toplevel) };
}

export async function resolveMemoryDir(config: { memoryDir: string }, cwd: string): Promise<string> {
	const { kind, key } = await projectIdentity(cwd);
	return join(config.memoryDir, kind, projectDirName(key));
}
