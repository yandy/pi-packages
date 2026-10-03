import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertInsideRoot,
	normalizeRemoteUrl,
	projectDirName,
	projectIdentity,
	resolveMemoryDir,
} from "../src/paths";
import { isReservedWindowsName } from "../src/windows-names";

const execFileP = promisify(execFile);

let dir: string;
let emptyGitConfig: string;

beforeEach(async () => {
	// Keep git hermetic: never read the machine's global or system config.
	// 用临时空文件而不是 `/dev/null`：Windows 上它会变成 `C:\dev\null`（不存在也会被 git 忽略，
	// 但语义依赖平台；临时文件在两个平台上都一样明确）。
	dir = await mkdtemp(join(tmpdir(), "pi-memory-paths-"));
	emptyGitConfig = join(dir, "gitconfig-empty");
	await writeFile(emptyGitConfig, "", "utf8");
	vi.stubEnv("GIT_CONFIG_GLOBAL", emptyGitConfig);
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileP("git", args, { cwd });
	return stdout.trim();
}

async function initRepo(cwd: string, remote?: string): Promise<void> {
	await git(["init", "-q"], cwd);
	if (remote) await git(["remote", "add", "origin", remote], cwd);
}

describe("resolveMemoryDir", () => {
	it("joins memoryDir with the git kind and readable dir name", async () => {
		await initRepo(dir, "https://github.com/yandy/pi-packages.git");
		expect(await resolveMemoryDir({ memoryDir: "/mem" }, dir)).toBe(
			join(resolve("/mem"), "git", "github.com__yandy__pi-packages"),
		);
	});

	it("joins memoryDir with the local kind and readable dir name", async () => {
		// memoryDir 与 key 都要先经 resolve()/projectDirName()：win32 上 `resolve("/mem")` 是
		// `C:\mem`，手写的 `/mem/local/...` 模板不再等于实现返回的宿主机路径。
		expect(await resolveMemoryDir({ memoryDir: "/mem" }, dir)).toBe(
			join(resolve("/mem"), "local", projectDirName(resolve(dir))),
		);
	});

	it("maps two clones of the same remote to one memory directory", async () => {
		const cloneA = join(dir, "clone-a");
		const cloneB = join(dir, "clone-b");
		await mkdir(cloneA, { recursive: true });
		await mkdir(cloneB, { recursive: true });
		await initRepo(cloneA, "https://github.com/yandy/pi-packages.git");
		await initRepo(cloneB, "git@github.com:yandy/pi-packages.git");
		const expected = join(resolve("/mem"), "git", "github.com__yandy__pi-packages");
		expect(await resolveMemoryDir({ memoryDir: "/mem" }, cloneA)).toBe(expected);
		expect(await resolveMemoryDir({ memoryDir: "/mem" }, cloneB)).toBe(expected);
	});

	it("maps a linked worktree to the same memory directory as the main checkout", async () => {
		await initRepo(dir, "https://github.com/yandy/pi-packages.git");
		await git(["config", "user.email", "test@example.com"], dir);
		await git(["config", "user.name", "Test"], dir);
		await git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
		const worktree = join(dir, "wt");
		await git(["worktree", "add", "-q", "-b", "wt-branch", worktree], dir);
		expect(await resolveMemoryDir({ memoryDir: "/mem" }, worktree)).toBe(
			join(resolve("/mem"), "git", "github.com__yandy__pi-packages"),
		);
	});

	it("honours a custom memoryDir root", async () => {
		await initRepo(dir, "git@github.com:yandy/pi-packages.git");
		expect(await resolveMemoryDir({ memoryDir: "/custom/root" }, dir)).toBe(
			join(resolve("/custom/root"), "git", "github.com__yandy__pi-packages"),
		);
	});
});

describe("projectDirName", () => {
	it("joins git keys with double underscores", () => {
		expect(projectDirName("github.com/yandy/pi-packages")).toBe("github.com__yandy__pi-packages");
	});

	it("drops the leading slash of absolute paths", () => {
		expect(projectDirName("/home/yandy/workspace/scratch")).toBe("home__yandy__workspace__scratch");
	});

	it("keeps subgroup paths", () => {
		expect(projectDirName("gitlab.com/foo/bar/repo")).toBe("gitlab.com__foo__bar__repo");
	});

	it("escapes characters that are unsafe in file names", () => {
		expect(projectDirName("/home/yandy/proj/with:colon")).toBe("home__yandy__proj__with_3acolon");
	});

	it("keeps backslashes literal (POSIX naming)", () => {
		// 显式传平台：命名规则跟随平台，POSIX 上反斜杠是普通字符（win32 上它是分隔符，
		// 由下面的 win32 用例覆盖）。
		expect(projectDirName("/home/a\\b", { platform: "linux" })).toBe("home__a\\b");
	});

	it("drops empty, . and .. segments", () => {
		expect(projectDirName("/home/../home/./proj")).toBe("home__home__proj");
	});

	it("falls back to root when no segment remains", () => {
		expect(projectDirName("/")).toBe("root");
		expect(projectDirName("..")).toBe("root");
	});

	it("truncates long keys to 100 chars plus a hash suffix", () => {
		const key = `github.com/${"a".repeat(40)}/${"b".repeat(120)}`;
		const name = projectDirName(key);
		expect(name.startsWith(`github.com__${"a".repeat(40)}__${"b".repeat(46)}`)).toBe(true);
		expect(name).toMatch(/__[0-9a-f]{8}$/);
		expect(name.length).toBe(110);
	});

	it("is deterministic and distinct for different long keys", () => {
		const a = `github.com/x/${"a".repeat(120)}`;
		const b = `github.com/x/${"a".repeat(119)}b`;
		expect(projectDirName(a)).toBe(projectDirName(a));
		expect(projectDirName(a)).not.toBe(projectDirName(b));
	});

	it("caps truncated names by UTF-8 bytes, not UTF-16 units", () => {
		const key = `/home/yandy/${"工".repeat(115)}`;
		const name = projectDirName(key);
		expect(name).toMatch(/__[0-9a-f]{8}$/);
		expect(name.startsWith(`home__yandy__${"工".repeat(29)}`)).toBe(true);
		expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(110);
	});

	it("never splits a surrogate pair when truncating", () => {
		const key = `/home/yandy/${"😀".repeat(60)}`;
		const name = projectDirName(key);
		const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		expect(name).not.toMatch(loneSurrogate);
	});

	it("never splits a grapheme cluster when truncating", () => {
		const zwjFamily = projectDirName(`/home/yandy/${"👨‍👩‍👧".repeat(40)}`);
		expect(zwjFamily.endsWith("\u200D")).toBe(false);
		const flags = projectDirName(`/home/yandy/${"🇯🇵".repeat(60)}`);
		const regionalIndicators = flags.match(/[\u{1F1E6}-\u{1F1FF}]/gu) ?? [];
		expect(regionalIndicators.length % 2).toBe(0);
	});

	it("splits on backslashes on win32 so a drive path stays one component", () => {
		expect(projectDirName("C:\\Users\\yandy\\workspace\\proj", { platform: "win32" })).toBe(
			"C_3a__Users__yandy__workspace__proj",
		);
	});

	it("keeps the POSIX result byte-identical when the platform is posix", () => {
		// D2：win32 专属分支不得影响 POSIX 输出
		expect(projectDirName("/home/a\\b", { platform: "linux" })).toBe("home__a\\b");
		expect(projectDirName("C:\\Users\\yandy", { platform: "linux" })).toBe("C_3a\\Users\\yandy");
	});

	it("neutralises UNC prefixes and mixed separators on win32", () => {
		expect(projectDirName("\\\\server\\share\\proj", { platform: "win32" })).toBe("server__share__proj");
		expect(projectDirName("C:/Users\\yandy/proj", { platform: "win32" })).toBe("C_3a__Users__yandy__proj");
	});

	it("drops dot segments on win32 so a crafted remote cannot climb out", () => {
		expect(projectDirName("host/a\\..\\..\\..\\etc", { platform: "win32" })).toBe("host__a__etc");
	});

	it("escapes a trailing dot or space on win32 only", () => {
		expect(projectDirName("C:\\Users\\yandy\\proj.", { platform: "win32" })).toBe("C_3a__Users__yandy__proj_2e");
		expect(projectDirName("C:\\Users\\yandy\\proj ", { platform: "win32" })).toBe("C_3a__Users__yandy__proj_20");
		expect(projectDirName("/home/yandy/proj.", { platform: "linux" })).toBe("home__yandy__proj.");
	});

	it("prefixes a reserved device name even when it is the first label of the joined name", () => {
		// Windows 只把「第一个 . 之前的部分」当设备：con.md__repo 仍然命中 CON
		expect(projectDirName("con.md/repo", { platform: "win32" })).toBe("_con.md__repo");
		expect(projectDirName("nul", { platform: "win32" })).toBe("_nul");
	});

	it("keeps a device-looking inner segment untouched when the final name is safe", () => {
		expect(projectDirName("C:\\con\\proj", { platform: "win32" })).toBe("C_3a__con__proj");
	});

	it("always yields a single, Windows-legal component for hostile keys", () => {
		const keys = [
			"C:\\Users\\yandy\\proj",
			"\\\\server\\share",
			"host/a\\..\\..\\..\\etc",
			"con.md/repo",
			"nul",
			"aux.",
			"C:\\",
			"..\\..\\..\\",
			`C:\\${"x".repeat(200)}`,
			"C:\\Users\\yandy\\proj ",
			"host\\\\double\\sep",
			"C:/mixed\\separators/final",
		];
		for (const key of keys) {
			const name = projectDirName(key, { platform: "win32" });
			expect(name.includes("/"), `${key} -> ${name}`).toBe(false);
			expect(name.includes("\\"), `${key} -> ${name}`).toBe(false);
			expect(/[. ]$/.test(name), `${key} -> ${name}`).toBe(false);
			expect(isReservedWindowsName(name), `${key} -> ${name}`).toBe(false);
			// 在 win32 语义下 join 进 memoryDir 后仍在 memoryDir 之内
			const base = "C:\\mem";
			const dir = win32.resolve(win32.join(base, "local", name));
			const rel = win32.relative(base, dir);
			expect(rel.startsWith("..") || isAbsolute(rel), `${key} -> ${dir}`).toBe(false);
		}
	});
});

describe("normalizeRemoteUrl", () => {
	it("normalizes https URLs", () => {
		expect(normalizeRemoteUrl("https://github.com/yandy/pi-packages.git")).toBe("github.com/yandy/pi-packages");
	});
	it("normalizes http URLs", () => {
		expect(normalizeRemoteUrl("http://example.com/team/repo.git")).toBe("example.com/team/repo");
	});
	it("normalizes scp-style ssh URLs to the same key as https", () => {
		expect(normalizeRemoteUrl("git@github.com:yandy/pi-packages.git")).toBe("github.com/yandy/pi-packages");
	});
	it("accepts scp-style URLs without a user", () => {
		expect(normalizeRemoteUrl("github.com:yandy/pi-packages.git")).toBe("github.com/yandy/pi-packages");
	});
	it("accepts git+ scheme aliases", () => {
		expect(normalizeRemoteUrl("git+ssh://git@github.com/yandy/pi-packages.git")).toBe("github.com/yandy/pi-packages");
		expect(normalizeRemoteUrl("git+https://github.com/yandy/pi-packages.git")).toBe("github.com/yandy/pi-packages");
		expect(normalizeRemoteUrl("git+file:///srv/repos/foo.git")).toBeNull();
	});
	it("normalizes git:// URLs to the same key as https", () => {
		expect(normalizeRemoteUrl("git://github.com/yandy/pi-packages.git")).toBe("github.com/yandy/pi-packages");
	});
	it("strips port, credentials and trailing separators", () => {
		expect(normalizeRemoteUrl("ssh://git@gitlab.com:2222/grp/sub/repo.git")).toBe("gitlab.com/grp/sub/repo");
		expect(normalizeRemoteUrl("https://user:pass@github.com/o/r.git")).toBe("github.com/o/r");
		expect(normalizeRemoteUrl("https://user:pa@ss@github.com/o/r.git")).toBe("github.com/o/r");
		expect(normalizeRemoteUrl("https://github.com/yandy/pi-packages.git/")).toBe("github.com/yandy/pi-packages");
	});
	it("lowercases the host and strips a case-insensitive .git suffix", () => {
		expect(normalizeRemoteUrl("https://GitHub.com/Owner/Repo.GIT")).toBe("github.com/Owner/Repo");
	});
	it("normalizes bracketed IPv6 hosts like their ssh:// form", () => {
		expect(normalizeRemoteUrl("[2001:db8::1]:o/r.git")).toBe("[2001:db8::1]/o/r");
		expect(normalizeRemoteUrl("ssh://git@[2001:db8::1]/o/r.git")).toBe("[2001:db8::1]/o/r");
	});

	it("normalizes IDN hosts and host case identically across forms", () => {
		const expected = "xn--fsqu00a.com/o/r";
		expect(normalizeRemoteUrl("https://例子.com/o/r.git")).toBe(expected);
		expect(normalizeRemoteUrl("ssh://例子.com/o/r.git")).toBe(expected);
		expect(normalizeRemoteUrl("例子.com:o/r.git")).toBe(expected);
	});

	it("strips the git:// port", () => {
		expect(normalizeRemoteUrl("git://github.com:9418/yandy/pi-packages.git")).toBe("github.com/yandy/pi-packages");
	});
	it("rejects non-git protocols and local paths", () => {
		expect(normalizeRemoteUrl("file:///srv/repos/foo.git")).toBeNull();
		expect(normalizeRemoteUrl("/srv/repos/bar")).toBeNull();
		expect(normalizeRemoteUrl("../repo")).toBeNull();
		expect(normalizeRemoteUrl("")).toBeNull();
	});
	it("rejects URLs without a repository path", () => {
		expect(normalizeRemoteUrl("https://github.com/")).toBeNull();
		expect(normalizeRemoteUrl("https://github.com")).toBeNull();
		expect(normalizeRemoteUrl("github.com:")).toBeNull();
	});
});

describe("projectIdentity", () => {
	it("classifies a non-git directory as local with its absolute path", async () => {
		expect(await projectIdentity(dir)).toEqual({ kind: "local", key: resolve(dir) });
	});

	it("classifies a deleted working directory as local", async () => {
		const gone = join(dir, "deleted");
		expect(await projectIdentity(gone)).toEqual({ kind: "local", key: resolve(gone) });
	});

	it("normalizes an https remote to host/owner/repo", async () => {
		await initRepo(dir, "https://github.com/yandy/pi-packages.git");
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "github.com/yandy/pi-packages" });
	});

	it("normalizes scp-style ssh and git:// remotes to the https key", async () => {
		await initRepo(dir, "git@github.com:yandy/pi-packages.git");
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "github.com/yandy/pi-packages" });
		await git(["remote", "set-url", "origin", "git://github.com/yandy/pi-packages.git"], dir);
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "github.com/yandy/pi-packages" });
	});

	it("keeps subgroup paths and strips port and userinfo", async () => {
		await initRepo(dir, "ssh://git@gitlab.com:2222/grp/sub/repo.git");
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "gitlab.com/grp/sub/repo" });
	});

	it("prefers origin over other remotes", async () => {
		await initRepo(dir);
		await git(["remote", "add", "aaa", "https://example.com/aaa/repo.git"], dir);
		await git(["remote", "add", "origin", "https://example.com/origin/repo.git"], dir);
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "example.com/origin/repo" });
	});

	it("uses the alphabetically first remote when origin is missing", async () => {
		await initRepo(dir);
		await git(["remote", "add", "zeta", "https://example.com/zeta/repo.git"], dir);
		await git(["remote", "add", "alpha", "https://example.com/alpha/repo.git"], dir);
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "example.com/alpha/repo" });
	});

	it("accepts scp-style remotes without a user and git+ scheme aliases", async () => {
		await initRepo(dir, "github.com:yandy/pi-packages.git");
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "github.com/yandy/pi-packages" });
		await git(["remote", "set-url", "origin", "git+ssh://git@github.com/yandy/pi-packages.git"], dir);
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "github.com/yandy/pi-packages" });
		await git(["remote", "set-url", "origin", "git+https://github.com/yandy/pi-packages.git"], dir);
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "github.com/yandy/pi-packages" });
	});

	it("falls back to the first usable remote, not the first non-empty one", async () => {
		await initRepo(dir, "/srv/mirror/pi-packages.git");
		await git(["remote", "add", "upstream", "https://github.com/yandy/pi-packages.git"], dir);
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "github.com/yandy/pi-packages" });
	});

	it("ignores url.*.insteadOf rewrites from the global git config", async () => {
		await initRepo(dir, "https://github.com/yandy/pi-packages.git");
		const globalConfig = join(dir, "gitconfig");
		await writeFile(globalConfig, '[url "/srv/mirror/"]\n\tinsteadOf = https://github.com/\n', "utf8");
		vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "github.com/yandy/pi-packages" });
	});

	it("uses the fetch URL when a remote has multiple URLs", async () => {
		await initRepo(dir, "https://github.com/yandy/pi-packages.git");
		await git(["remote", "set-url", "--add", "origin", "https://second.example.com/o/r.git"], dir);
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "github.com/yandy/pi-packages" });
	});

	it("ignores push URLs", async () => {
		await initRepo(dir, "https://github.com/yandy/pi-packages.git");
		await git(["remote", "set-url", "--push", "origin", "https://push.example.com/o/r.git"], dir);
		expect(await projectIdentity(dir)).toEqual({ kind: "git", key: "github.com/yandy/pi-packages" });
	});

	it("falls back to local when no remote exists", async () => {
		await initRepo(dir);
		const toplevel = await git(["rev-parse", "--show-toplevel"], dir);
		expect(await projectIdentity(dir)).toEqual({ kind: "local", key: resolve(toplevel) });
	});

	it("falls back to local for file:// and local-path remotes", async () => {
		await initRepo(dir, "file:///srv/repos/foo.git");
		const toplevel = await git(["rev-parse", "--show-toplevel"], dir);
		expect(await projectIdentity(dir)).toEqual({ kind: "local", key: resolve(toplevel) });

		await git(["remote", "set-url", "origin", "/srv/repos/bar"], dir);
		expect(await projectIdentity(dir)).toEqual({ kind: "local", key: resolve(toplevel) });
	});

	it("falls back to local for a remote without a repository path", async () => {
		await initRepo(dir, "https://github.com/");
		const toplevel = await git(["rev-parse", "--show-toplevel"], dir);
		expect(await projectIdentity(dir)).toEqual({ kind: "local", key: resolve(toplevel) });
	});

	it("falls back to local for a bare repository with a remote", async () => {
		// 裸仓库没有工作树：`git rev-parse --show-toplevel` 以 `fatal: this operation must be run in a work tree`
		// （exit 128）退出 → `gitToplevel` 返回 null → 落回 local/<绝对路径>，不会因 remote 变成 git/<remote 身份>。
		const bare = join(dir, "bare-with-remote.git");
		await git(["init", "-q", "--bare", bare], dir);
		await git(["remote", "add", "origin", "https://github.com/yandy/pi-packages.git"], bare);
		expect(await projectIdentity(bare)).toEqual({ kind: "local", key: resolve(bare) });
	});

	it("falls back to local for a bare repository without a remote", async () => {
		const bare = join(dir, "bare.git");
		await git(["init", "-q", "--bare", bare], dir);
		expect(await projectIdentity(bare)).toEqual({ kind: "local", key: resolve(bare) });
	});

	it("falls back to local when the cwd is inside .git", async () => {
		// `.git` 内部同样没有工作树（`--show-toplevel` 同样 exit 128 → null），但 `git config` 仍能读到
		// 仓库的 remote。必须保留既有的 local/<绝对路径> 身份，而不是因 remote 变成 git/<remote 身份>。
		await initRepo(dir, "https://github.com/yandy/pi-packages.git");
		expect(await projectIdentity(join(dir, ".git"))).toEqual({ kind: "local", key: resolve(join(dir, ".git")) });
	});

	it("resolves the same identity from a subdirectory", async () => {
		await initRepo(dir, "https://github.com/yandy/pi-packages.git");
		const sub = join(dir, "packages", "inner");
		await mkdir(sub, { recursive: true });
		expect(await projectIdentity(sub)).toEqual({ kind: "git", key: "github.com/yandy/pi-packages" });
	});
});

describe("assertInsideRoot", () => {
	it("accepts a directory below the root", () => {
		expect(() => assertInsideRoot("/mem", join("/mem", "git", "github.com__o__r"))).not.toThrow();
	});

	it("rejects a directory outside the root or the root itself", () => {
		expect(() => assertInsideRoot("/mem", "/etc")).toThrow(/escapes/);
		expect(() => assertInsideRoot("/mem", join("/mem", "..", "etc"))).toThrow(/escapes/);
		expect(() => assertInsideRoot("/mem", "/mem")).toThrow(/escapes/);
	});

	it("accepts the pre-fix multi-level name but rejects one that climbs out of the root", () => {
		// 旧实现在 win32 上把 `C:\Users\yandy` 派生成 `C_3a\Users\yandy`，join 之后变成多级路径
		const base = "C:\\mem";
		const escaped = win32.resolve(win32.join(base, "local", "C_3a\\Users\\yandy"));
		expect(escaped.startsWith(win32.join(base, "local"))).toBe(true); // 只是多级，没逃出
		expect(() => assertInsideRoot(base, escaped, "win32")).not.toThrow();

		// 带 `..` 的畸形 key 才会真的逃出：这就是断言要拦住的形态
		const climbing = win32.resolve(win32.join(base, "local", "host__a\\..\\..\\..\\etc"));
		expect(() => assertInsideRoot(base, climbing, "win32")).toThrow(/escapes/);
	});

	it("compares case-insensitively on win32", () => {
		expect(() => assertInsideRoot("C:\\mem", "C:\\MEM\\local\\x", "win32")).not.toThrow();
		expect(() => assertInsideRoot("/mem", "/MEM/local/x", "linux")).toThrow(/escapes/);
	});
});
