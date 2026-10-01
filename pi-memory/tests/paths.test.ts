import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	normalizeRemoteUrl,
	projectDirName,
	projectIdentity,
	resolveMemoryDir,
} from "../src/paths";

const execFileP = promisify(execFile);

let dir: string;

beforeEach(async () => {
	// Keep git hermetic: never read the machine's global or system config.
	vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	dir = await mkdtemp(join(tmpdir(), "pi-memory-paths-"));
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
			join("/mem", "git", "github.com__yandy__pi-packages"),
		);
	});

	it("joins memoryDir with the local kind and readable dir name", async () => {
		const expected = `/mem/local/${resolve(dir).slice(1).split("/").join("__")}`;
		expect(await resolveMemoryDir({ memoryDir: "/mem" }, dir)).toBe(expected);
	});

	it("maps two clones of the same remote to one memory directory", async () => {
		const cloneA = join(dir, "clone-a");
		const cloneB = join(dir, "clone-b");
		await mkdir(cloneA, { recursive: true });
		await mkdir(cloneB, { recursive: true });
		await initRepo(cloneA, "https://github.com/yandy/pi-packages.git");
		await initRepo(cloneB, "git@github.com:yandy/pi-packages.git");
		expect(await resolveMemoryDir({ memoryDir: "/mem" }, cloneA)).toBe("/mem/git/github.com__yandy__pi-packages");
		expect(await resolveMemoryDir({ memoryDir: "/mem" }, cloneB)).toBe("/mem/git/github.com__yandy__pi-packages");
	});

	it("maps a linked worktree to the same memory directory as the main checkout", async () => {
		await initRepo(dir, "https://github.com/yandy/pi-packages.git");
		await git(["config", "user.email", "test@example.com"], dir);
		await git(["config", "user.name", "Test"], dir);
		await git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
		const worktree = join(dir, "wt");
		await git(["worktree", "add", "-q", "-b", "wt-branch", worktree], dir);
		expect(await resolveMemoryDir({ memoryDir: "/mem" }, worktree)).toBe("/mem/git/github.com__yandy__pi-packages");
	});

	it("honours a custom memoryDir root", async () => {
		await initRepo(dir, "git@github.com:yandy/pi-packages.git");
		expect(await resolveMemoryDir({ memoryDir: "/custom/root" }, dir)).toBe(
			join("/custom/root", "git", "github.com__yandy__pi-packages"),
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
		expect(projectDirName("/home/a\\b")).toBe("home__a\\b");
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

	it("resolves the same identity from a subdirectory", async () => {
		await initRepo(dir, "https://github.com/yandy/pi-packages.git");
		const sub = join(dir, "packages", "inner");
		await mkdir(sub, { recursive: true });
		expect(await projectIdentity(sub)).toEqual({ kind: "git", key: "github.com/yandy/pi-packages" });
	});
});
