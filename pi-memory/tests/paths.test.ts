import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	normalizeRemoteUrl,
	projectDirName,
	projectIdentity,
	resolveMemoryDir,
	safeTopicPath,
} from "../src/paths";

const execFileP = promisify(execFile);

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-memory-paths-"));
});

afterEach(async () => {
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
		expect(await resolveMemoryDir({ memoryDir: "/mem" }, dir)).toBe(
			join("/mem", "local", projectDirName(resolve(dir))),
		);
	});

	it("honours a custom memoryDir root", async () => {
		await initRepo(dir, "git@github.com:yandy/pi-packages.git");
		expect(await resolveMemoryDir({ memoryDir: "/custom/root" }, dir)).toBe(
			join("/custom/root", "git", "github.com__yandy__pi-packages"),
		);
	});
});

describe("safeTopicPath", () => {
	it("accepts a normal filename", () => {
		expect(safeTopicPath("/tmp/mem/abc", "debugging.md")).toBe(join("/tmp/mem/abc", "debugging.md"));
	});
	it("throws on path traversal with ..", () => {
		expect(() => safeTopicPath("/tmp/mem/abc", "../etc/passwd")).toThrow();
	});
	it("throws on absolute path", () => {
		expect(() => safeTopicPath("/tmp/mem/abc", "/etc/passwd")).toThrow();
	});
	it("throws on backslash traversal", () => {
		expect(() => safeTopicPath("/tmp/mem/abc", "..\\..\\etc")).toThrow();
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

	it("treats backslashes as separators", () => {
		expect(projectDirName("C:\\Users\\me\\proj")).toBe("C_3a__Users__me__proj");
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
		expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(255);
	});

	it("never splits a surrogate pair when truncating", () => {
		const key = `/home/yandy/${"😀".repeat(60)}`;
		const name = projectDirName(key);
		const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		expect(name).not.toMatch(loneSurrogate);
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
	it("normalizes git:// URLs to the same key as https", () => {
		expect(normalizeRemoteUrl("git://github.com/yandy/pi-packages.git")).toBe("github.com/yandy/pi-packages");
	});
	it("strips port, credentials and trailing separators", () => {
		expect(normalizeRemoteUrl("ssh://git@gitlab.com:2222/grp/sub/repo.git")).toBe("gitlab.com/grp/sub/repo");
		expect(normalizeRemoteUrl("https://user:pass@github.com/o/r.git")).toBe("github.com/o/r");
		expect(normalizeRemoteUrl("https://github.com/yandy/pi-packages.git/")).toBe("github.com/yandy/pi-packages");
	});
	it("lowercases the host and strips a case-insensitive .git suffix", () => {
		expect(normalizeRemoteUrl("https://GitHub.com/Owner/Repo.GIT")).toBe("github.com/Owner/Repo");
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
