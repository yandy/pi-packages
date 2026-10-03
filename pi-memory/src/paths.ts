import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join, posix, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { windowsSafeName } from "./windows-names";

const execFileP = promisify(execFile);
const GIT_TIMEOUT_MS = 3000;

/**
 * 仓库根：`git rev-parse --show-toplevel`（绝对路径）。
 *
 * 2026-10-04 用户决定回到这个实现（spec Ruling 12，**撤销 Ruling 3**）：Windows 上只用
 * PowerShell、Git Bash 不在支持面内，所以「MSYS 形态输出会让 `resolve()` 得到 `C:\c\…`」这条
 * 动机消失。随之删除了 `--is-inside-work-tree` 判据与 MSYS 仿真用例：裸仓库、cwd 在 `.git`
 * 内部（含 `.git/objects`）时 git 以 `fatal: this operation must be run in a work tree` 退出，
 * 这里天然返回 `null`，调用方落回 `local/<绝对路径>`；非仓库同样由 catch 返回 `null`。
 *
 * 已知限制（spec §7）：若 PATH 上的 `git` 是 cygwin/MSYS 构建（对任何调用者都打印
 * `/cygdrive/c/…` 这类 POSIX 形态路径），`resolve()` 会得到错误前缀 —— 同一项目会出现第二个
 * 记忆目录。Git for Windows 的 `git.exe` 打印原生路径，不受影响。
 */
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

export interface NamingOptions {
	/** 命名规则跟随的平台（默认 `process.platform`）。win32 上 `\` 作为分隔符参与分段。 */
	platform?: NodeJS.Platform;
}

// win32 上 `\` 也是分隔符 —— 它必须参与分段，而不是被转义成字面量：转义会让整个名字在
// `join(memoryDir, …)` 时仍被拆成多级目录（`local/C_3a/Users/...`），而畸形 key
// （`host/a\..\..\..\etc`）里的 `..` 段还能让目录逃出 memoryDir（spec §1.2 P1/P7）。
const PATH_SEPARATORS = /[/\\]/;
const POSIX_SEPARATORS = /\//;

/**
 * Encode a project key into a single, human-readable directory name.
 * `host/repo/path` → `host__repo__path`; `/abs/path` → `abs__path`。
 *
 * 平台差异（spec Ruling 1/D2）：win32 上按 `/` 与 `\` 双分隔符分段，并保证输出满足三条
 * 不变量 —— 不含分隔符、不以 `.`/空格结尾、不是保留设备名；POSIX 上 `\` 仍是普通字符，
 * 输出与 win32 支持引入前逐字节一致。
 */
export function projectDirName(key: string, options?: NamingOptions): string {
	const platform = options?.platform ?? process.platform;
	const separator = platform === "win32" ? PATH_SEPARATORS : POSIX_SEPARATORS;
	const segments = key
		.split(separator)
		.filter((segment) => segment !== "" && segment !== "." && segment !== "..")
		.map(escapeSegment);
	if (segments.length === 0) return "root";
	const joined = segments.join("__");
	// Filesystems cap one name at 255 bytes: count bytes so multi-byte names
	// (CJK, emoji) cannot exceed the limit, and cut on code point boundaries.
	const name =
		Buffer.byteLength(joined, "utf8") <= DIR_NAME_MAX_BYTES
			? joined
			: `${truncateToBytes(joined, DIR_NAME_KEEP_BYTES)}__${createHash("sha256").update(key).digest("hex").slice(0, HASH_LENGTH)}`;
	return platform === "win32" ? windowsSafeName(name) : name;
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
 * Windows 盘符路径（`Z:\…` / `Z:/…`）。在 win32 上这是**本地路径**，不是 scp 的 `host:path`：
 * Git for Windows 就这么解释（用户可以 `git clone Z:\some.git`）；而 `resolve()` 会把它当成
 * host `z`（spec Ruling 13）。POSIX 上同一串是合法的 scp 写法（host `C`），与 git 一致，不改判。
 */
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;

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
 * Returns null for file:// URLs, local paths and URLs without a repository path
 * （因此盘符本地 remote 在 win32 上也返回 null → 落回 `local/<绝对路径>`）。
 */
export function normalizeRemoteUrl(url: string, platform: NodeJS.Platform = process.platform): string | null {
	const raw = url.trim();
	if (!raw) return null;
	// win32 上「盘符 + 分隔符」开头的是本地路径，不是 scp 的 host（见 `WINDOWS_DRIVE_PATH`）。
	if (platform === "win32" && WINDOWS_DRIVE_PATH.test(raw)) return null;

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

/** Resolve the project identity: normalized git remote, or the project root path.
 *
 * `platform` 决定盘符远程的归类（win32 上当本地路径，见 `normalizeRemoteUrl`）；其余平台行为不变。
 */
export async function projectIdentity(cwd: string, platform: NodeJS.Platform = process.platform): Promise<ProjectIdentity> {
	const toplevel = await gitToplevel(cwd);
	if (!toplevel) return { kind: "local", key: resolve(cwd) };
	for (const { url } of await gitRemoteUrls(cwd)) {
		const key = normalizeRemoteUrl(url, platform);
		if (key) return { kind: "git", key };
	}
	return { kind: "local", key: resolve(toplevel) };
}

type PathApi = typeof import("node:path");

/**
 * 断言 `dir` 确实是 `base` 之内的一层（spec §4.2 / D4）。
 *
 * 派生名一旦含有分隔符，`join` 就会把它拆成多级路径 —— 畸形 remote（key 里带 `\..\..`）
 * 能让目录逃出 `memoryDir`。fail-closed：越界即抛错，由 session_start 转成配置错误态，
 * 而不是悄悄写到别的地方。
 *
 * 导出仅为直接单测：POSIX 命名下 `projectDirName` 不可能产出分隔符，公开 API 走不到这条分支。
 * `platform` 决定用哪套 `path` 语义（win32 的 `relative` 大小写不敏感、认 `\` 与盘符）。
 */
export function assertInsideRoot(base: string, dir: string, platform: NodeJS.Platform = process.platform): void {
	const api: PathApi = platform === "win32" ? win32 : posix;
	const rel = api.relative(base, dir);
	if (rel === "" || rel.startsWith("..") || api.isAbsolute(rel)) {
		throw new Error(`Refusing to use memory directory ${dir}: it escapes ${base}`);
	}
}

export async function resolveMemoryDir(config: { memoryDir: string }, cwd: string): Promise<string> {
	const { kind, key } = await projectIdentity(cwd);
	// 相对路径配置（如 `"./memory"`）固化成绝对路径：逻辑锁的 key 用这个字符串，
	// 同一目录的不同写法不该得到两把锁（见 `memory-store.ts` 的 `#logicalKey`）。
	const base = resolve(config.memoryDir);
	const dir = join(base, kind, projectDirName(key));
	assertInsideRoot(base, dir);
	return dir;
}
