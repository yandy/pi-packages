import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfiguredRootsWarningsForTests, resolveConfiguredRoots } from "../src/config";
import { canonicalPath } from "../src/policy";

/**
 * spec 2026-10-14 §4.3：`writableRoots` 的解析规则。
 *
 * 全部用注入的 homeDir/agentDir/exists/warn，不碰真实 $HOME、真实 getAgentDir、真实 console——
 * 唯一用到真实文件系统的是「存在性」与「symlink 解析」，夹具建在 mkdtemp 下（testing.md「文件系统隔离」）。
 * 注意 `sep` 是 fence.ts 的模块级常量，按**运行**平台定死，所以 win32 的分隔符/盘符语义在 Linux 上
 * 只能覆盖到「非绝对即丢弃」这一层；真机 win32 行为由 CI 的 windows-latest 覆盖。
 */

let root: string;
let homeDir: string;
let agentDir: string;
let warnings: string[];

/** 建一个真实存在的目录并返回其 canonical 路径。 */
function realDir(...parts: string[]): string {
	const dir = join(root, ...parts);
	mkdirSync(dir, { recursive: true });
	return canonicalPath(dir);
}

beforeEach(() => {
	root = canonicalPath(mkdtempSync(join(tmpdir(), "cfgroots-")));
	homeDir = join(root, "home", "yandy");
	agentDir = join(homeDir, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	warnings = [];
	resetConfiguredRootsWarningsForTests();
});
afterEach(() => {
	resetConfiguredRootsWarningsForTests();
	rmSync(root, { recursive: true, force: true });
});

function resolve(entries: readonly string[], extra: Parameters<typeof resolveConfiguredRoots>[1] = {}) {
	return resolveConfiguredRoots(entries, {
		homeDir,
		agentDir,
		warn: (message) => warnings.push(message),
		...extra,
	});
}

describe("resolveConfiguredRoots: happy path", () => {
	it("returns [] for an empty list without touching the filesystem", () => {
		expect(resolve([])).toEqual([]);
		expect(resolve([], { exists: () => { throw new Error("must not stat"); } })).toEqual([]);
	});

	it("keeps an existing absolute directory, canonicalized", () => {
		const cache = realDir("cache", "uv");
		expect(resolve([join(root, "cache", "uv")])).toEqual([cache]);
	});

	it("keeps several roots in configuration order", () => {
		const a = realDir("a");
		const b = realDir("b");
		expect(resolve([join(root, "b"), join(root, "a")])).toEqual([b, a]);
	});

	it("expands ~ and ~/… against the injected home directory", () => {
		const uvCache = realDir("home", "yandy", ".cache", "uv");
		expect(resolve(["~/.cache/uv"])).toEqual([uvCache]);
	});

	// win32 跳过：建 symlink 需特权（开发者模式/管理员），与 policy.test.ts 同口径。
	it.skipIf(process.platform === "win32")("resolves symlinks to the real path, so the grant covers the 真身", () => {
		const target = realDir("real-cache");
		symlinkSync(target, join(root, "link-cache"));
		writeFileSync(join(target, "probe"), "x");
		expect(resolve([join(root, "link-cache")])).toEqual([target]);
	});
});

describe("resolveConfiguredRoots: dedupe", () => {
	it("collapses duplicates and two spellings of one directory", () => {
		const cache = realDir("cache");
		const withTrailing = `${join(root, "cache")}${sep}`;
		expect(resolve([join(root, "cache"), withTrailing, join(root, "cache")])).toEqual([cache]);
	});
});

describe("resolveConfiguredRoots: dropped entries (warn, never throw)", () => {
	it("drops a relative path", () => {
		realDir("cache");
		expect(resolve(["cache/uv"])).toEqual([]);
		expect(warnings.join(" ")).toMatch(/not an absolute path/u);
	});

	it("drops an empty / whitespace-only entry", () => {
		expect(resolve(["", "   "])).toEqual([]);
		expect(warnings.join(" ")).toMatch(/empty/u);
	});

	it("drops ~ itself: it is the home directory", () => {
		expect(resolve(["~"])).toEqual([]);
		expect(warnings.join(" ")).toMatch(/home directory/u);
	});

	it("drops the home directory and every ancestor of it, up to the filesystem root", () => {
		// 文件系统根用 parse().root 取：POSIX 是 "/"，win32 是 "C:\"。
		// 不能写字面 "/"——它在 win32 是**盘符相对**路径，按进程 cwd 所在盘解析，
		// CI 上 tmpdir() 在 C: 而 cwd 在 D: 时 "/" → "D:\"，根本不是 homeDir 的祖先。
		const fsRoot = parse(root).root;
		expect(resolve([homeDir, join(root, "home"), root, fsRoot])).toEqual([]);
		expect(warnings.filter((w) => /home directory/u.test(w)).length).toBe(4);
	});

	it("drops pi's agent directory and its ancestors (the sandbox must not rewrite pi's own config)", () => {
		expect(resolve([agentDir, join(homeDir, ".pi")])).toEqual([]);
		expect(warnings.join(" ")).toMatch(/agent directory/u);
	});

	it("drops a directory that does not exist, and says how to fix it", () => {
		const missing = join(root, "cache", "never-created");
		expect(resolve([missing])).toEqual([]);
		expect(warnings.join(" ")).toMatch(/does not exist/u);
	});

	it("does not create the missing directory as a side effect of parsing config", () => {
		const missing = join(root, "cache", "never-created");
		expect(resolve([missing])).toEqual([]);
		expect(existsSync(missing)).toBe(false);
	});

	it("keeps a sibling whose name merely starts with the home directory's name (separator boundary)", () => {
		// homeDir = <root>/home/yandy；<root>/home/yandy-extra 不是它的子路径，必须留下。
		const sibling = realDir("home", "yandy-extra");
		expect(resolve([sibling])).toEqual([sibling]);
	});

	it("keeps a directory below the home directory that is not the agent dir", () => {
		// 只拒「等于或包含 home / agentDir」；home **下面**的具体子目录是合法窄口子（如 ~/.cache/uv）。
		const uvCache = realDir("home", "yandy", ".cache", "uv");
		expect(resolve([uvCache])).toEqual([uvCache]);
	});

	it("honors an injected exists() so a root can be granted without touching the disk", () => {
		const virtual = join(root, "virtual");
		expect(resolve([virtual], { exists: () => true })).toEqual([canonicalPath(virtual)]);
	});
});

describe("resolveConfiguredRoots: warn de-duplication", () => {
	it("warns once per entry+reason across repeated calls (config is cached, resolution is per call)", () => {
		const missing = join(root, "nope");
		resolve([missing]);
		resolve([missing]);
		resolve([missing]);
		expect(warnings.filter((w) => /does not exist/u.test(w))).toHaveLength(1);
	});

	it("warns separately for two different entries", () => {
		resolve([join(root, "nope-1"), join(root, "nope-2")]);
		expect(warnings.filter((w) => /does not exist/u.test(w))).toHaveLength(2);
	});

	it("resetConfiguredRootsWarningsForTests re-arms the warning", () => {
		const missing = join(root, "nope");
		resolve([missing]);
		resetConfiguredRootsWarningsForTests();
		resolve([missing]);
		expect(warnings.filter((w) => /does not exist/u.test(w))).toHaveLength(2);
	});
});

describe("resolveConfiguredRoots: win32 runner asymmetry (Ruling 5)", () => {
	// 注入 platform:"win32" 时夹具必须用 win32 形状的路径：POSIX 拼写在 win32 口径下会被
	// 盘符规则拒掉（见下面「drive-relative」那组用例），测不到本组要测的东西。
	// canonicalPath 对不存在的路径保留原拼写，所以配合注入的 exists 即可，不需要真文件系统。
	const winCache = "C:\\Users\\u\\.cache\\uv";
	const win = { platform: "win32", caseSensitive: false, exists: () => true } as const;

	it("announces that the windows-acl runner ignores the extra roots, once", () => {
		resolve([winCache], win);
		resolve([winCache], win);
		const notes = warnings.filter((w) => /windows-acl runner/u.test(w));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatch(/write\/edit/u);
	});

	it("stays quiet on non-win32 platforms", () => {
		const cache = realDir("cache");
		resolve([cache], { platform: "linux" });
		expect(warnings.filter((w) => /windows-acl/u.test(w))).toHaveLength(0);
	});

	it("stays quiet when nothing resolved (no roots, nothing to be asymmetric about)", () => {
		resolve(["C:\\nope"], { ...win, exists: () => false });
		expect(warnings.filter((w) => /windows-acl/u.test(w))).toHaveLength(0);
	});
});

/**
 * win32 的盘符相对路径：`isAbsolute("/foo")` 在 win32 为 true，但 `/foo` 与裸 `/` 的含义是
 * 「当前盘的根下」，随进程 cwd 所在盘漂移。不拒的后果是 fail-open：一条 `"/"` 在 cwd 位于 D:
 * 时解析成 `D:\`，而危险根检查因为 homeDir 在 C: 根本命中不了，整个 D: 盘就被授予可写
 * （CI windows-latest 实测捕获）。fence.ts 对同类歧义拼写一律「视为不在任何授予根内」，此处同口径。
 */
describe("resolveConfiguredRoots: win32 drive-relative spellings are rejected", () => {
	const win = { platform: "win32", caseSensitive: false, exists: () => true } as const;

	it("rejects a bare / and any /-rooted path", () => {
		expect(resolve(["/"], win)).toEqual([]);
		expect(resolve(["/tmp/cache"], win)).toEqual([]);
		expect(warnings.join(" ")).toMatch(/drive letter or a UNC prefix/u);
	});

	it("rejects a bare drive letter and a drive-relative path", () => {
		expect(resolve(["C:"], win)).toEqual([]);
		expect(resolve(["C:work"], win)).toEqual([]);
	});

	it("accepts an explicit drive-letter path and a UNC share", () => {
		expect(resolve(["C:\\cache\\uv"], win)).toEqual(["C:\\cache\\uv"]);
		expect(resolve(["C:/cache/uv"], win)).toEqual(["C:/cache/uv"]);
		expect(resolve(["\\\\server\\share\\cache"], win)).toEqual(["\\\\server\\share\\cache"]);
	});

	it("the drive-relative rule is win32-only: POSIX keeps / and /-rooted paths", () => {
		const posix = { platform: "linux", exists: () => true } as const;
		expect(resolve(["/opt/scratch"], posix)).toEqual(["/opt/scratch"]);
	});
});

describe("resolveConfiguredRoots: agentDir unavailable", () => {
	it("skips the agentDir rule instead of throwing when getAgentDir cannot resolve", () => {
		const cache = realDir("cache");
		expect(resolve([cache], { agentDir: null })).toEqual([cache]);
	});
});
