import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSandboxBashOps } from "../src/bash-ops";
import { resetRunnerCache, selectRunner } from "../src/runners";
import type { ConfinedSandboxMode } from "../src/policy";
import { DEFAULT_SANDBOX_CONFIG } from "../src/config";
import { createPermissionState } from "../src/permission";
import { createSandboxTools } from "../src/tools";
import { getToolStoragePlan, resetToolStoragePlanCache } from "../src/tool-storage/detect";
import { resetToolStorageWarnings } from "../src/tool-storage/materialize";

resetRunnerCache();
const selected = selectRunner(5000);
const hooks = { discoverGpuDevices: () => [] };

// On win32 `createSandboxBashOps` refuses bash in every confined mode
// (Ruling 2), so these four cases cannot pass there by design; the real Windows
// confinement is covered by `tests/win32/e2e.test.ts` and the acceptance
// checklist. Skipping keeps "full suite green on Windows" meaningful instead of
// training the operator to ignore four known-red rows.
const skipConfinedBashCases = selected.runner === "unavailable" || process.platform === "win32";
describe.skipIf(skipConfinedBashCases)(`real confinement via ${selected.runner}`, () => {
	let ws: string;

	beforeAll(() => {
		ws = realpathSync.native(mkdtempSync(join(tmpdir(), "sbx-int-")));
	});
	afterAll(() => {
		rmSync(ws, { recursive: true, force: true });
		rmSync(`/etc/sbx-escape-${process.pid}`, { force: true }); // 仅在沙箱失效且 root 运行时才会存在，尽力清理
		rmSync(`/etc/sbx-int-extra-escape-${process.pid}`, { force: true }); // 同上，额外可写根用例的逃逸目标
	});

	async function run(mode: ConfinedSandboxMode, command: string) {
		const ops = createSandboxBashOps({ mode, workspaceRoot: ws, hooks });
		const chunks: Buffer[] = [];
		const result = await ops.exec(command, ws, { onData: (b) => chunks.push(b) });
		return { ...result, text: chunks.map((c) => c.toString()).join("") };
	}

	it("workspace-write: write inside the workspace succeeds", async () => {
		const r = await run("workspace-write", "touch inside.txt && echo ok");
		expect(r.exitCode).toBe(0);
		expect(r.text).toContain("ok");
	});

	it("workspace-write: write outside (to /etc) is denied and carries the marker", async () => {
		const r = await run("workspace-write", `touch /etc/sbx-escape-${process.pid}`);
		expect(r.exitCode).not.toBe(0);
		expect(r.text).toContain("[sandbox: file access denied under workspace-write mode]");
		expect(r.text).toContain("[sandbox: escalation available");
	});

	it("workspace-write: read outside the workspace succeeds (the core goal)", async () => {
		const r = await run("workspace-write", "cat /etc/hosts");
		expect(r.exitCode).toBe(0);
		expect(r.text).toContain("localhost");
	});

	it("read-only: write inside the workspace is denied too", async () => {
		const r = await run("read-only", "touch ro.txt");
		expect(r.exitCode).not.toBe(0);
		expect(r.text).toContain("[sandbox: file access denied under read-only mode]");
	});

	/**
	 * 额外可写根的夹具必须落在“默认授予根之外”才对 granting 有分辨力：workspace-write 下
	 * `/tmp` 与 `os.tmpdir()` 本来就是可写根（policy.defaultTmpRoots + bwrap 无条件 `--bind /tmp /tmp`），
	 * 放那里即使 extraRoots 没接线命令也会成功。改放包/仓库目录树内（vitest cwd = 包目录）：宿主可写，
	 * 而沙箱内仅由 `--ro-bind / /` 只读挂载——只有显式 extraRoots 才能把它翻转为可写。
	 */
	function repoTreeExtraDir(): string {
		return realpathSync.native(mkdtempSync(join(process.cwd(), ".sbx-int-extra-")));
	}

	it("workspace-write: 额外可写根可写，根外仍拒", async () => {
		const extra = repoTreeExtraDir();
		const outside = `/etc/sbx-int-extra-escape-${process.pid}`;
		try {
			// 分辨力锚点：同一目录、同一命令，不传 extraRoots 必须先被拒……
			const bare = createSandboxBashOps({ mode: "workspace-write", workspaceRoot: ws, hooks });
			const bareChunks: Buffer[] = [];
			const bareDenied = await bare.exec(`touch ${extra}/ok.txt`, ws, { onData: (b) => bareChunks.push(b) });
			expect(bareDenied.exitCode).not.toBe(0);
			expect(bareChunks.map((c) => c.toString()).join("")).toContain(
				"[sandbox: file access denied under workspace-write mode]",
			);

			// ……经 extraRoots 授予后同一条命令成功：翻转结果的正是这次 grant。
			const ops = createSandboxBashOps({ mode: "workspace-write", workspaceRoot: ws, extraRoots: [extra], hooks });
			const chunks: Buffer[] = [];
			const ok = await ops.exec(`touch ${extra}/ok.txt && echo ok`, ws, { onData: (b) => chunks.push(b) });
			expect(ok.exitCode).toBe(0);
			expect(chunks.map((c) => c.toString()).join("")).toContain("ok");

			// 根外（/etc，仍是 ro-bind）仍拒：grant 不是整盘放行。
			const deniedChunks: Buffer[] = [];
			const denied = await ops.exec(`touch ${outside}`, ws, { onData: (b) => deniedChunks.push(b) });
			expect(denied.exitCode).not.toBe(0);
			expect(deniedChunks.map((c) => c.toString()).join("")).toContain(
				"[sandbox: file access denied under workspace-write mode]",
			);
		} finally {
			rmSync(extra, { recursive: true, force: true });
		}
	});

	function shellQuote(value: string): string {
		return `'${value.replaceAll("'", `'\\''`)}'`;
	}

	function toolText(result: unknown): string {
		return (result as { content: Array<{ text?: string }> }).content.map((item) => item.text ?? "").join("\n");
	}

	function toolStorageFixture(mode: "workspace-write" | "read-only" = "workspace-write") {
		// HOME must be outside both the workspace and the default tmp roots; otherwise this
		// integration test would pass without the new grant.
		const root = realpathSync.native(mkdtempSync(join(process.cwd(), ".sbx-int-tool-storage-")));
		const workspace = join(root, "workspace");
		const home = join(root, "home");
		const agent = join(root, "agent");
		const bin = join(root, "bin");
		for (const path of [workspace, home, agent, bin]) mkdirSync(path, { recursive: true });
		writeFileSync(join(bin, "uv"), "");
		chmodSync(join(bin, "uv"), 0o755);
		writeFileSync(join(bin, "pnpm"), "");
		chmodSync(join(bin, "pnpm"), 0o755);
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PI_CODING_AGENT_DIR", agent);
		// The fake uv entry is first, but the real runner and node must remain resolvable.
		vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
		// No inherited override may move detection/materialization into the host's real stores.
		for (const name of [
			"UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "PIP_CACHE_DIR", "npm_config_cache", "NPM_CONFIG_CACHE",
			"COREPACK_HOME", "PNPM_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
			"YARN_CACHE_FOLDER", "YARN_GLOBAL_FOLDER", "BUN_INSTALL_CACHE_DIR", "GOPATH", "GOMODCACHE", "GOCACHE",
			"MAVEN_USER_HOME", "GRADLE_USER_HOME",
		]) vi.stubEnv(name, "");
		resetToolStoragePlanCache();
		const tools = createSandboxTools({
			cwd: workspace,
			permission: createPermissionState(),
			platform: process.platform,
			selected,
			hooks,
			getConfig: () => ({ ...DEFAULT_SANDBOX_CONFIG, mode, toolStorage: true }),
		});
		const ctx = {
			cwd: workspace,
			hasUI: false,
			sessionManager: { getSessionId: () => "tool-storage-integration", getSessionFile: () => join(root, "session.jsonl") },
			ui: { select: vi.fn(async () => undefined), input: vi.fn(async () => undefined), notify: vi.fn() },
		};
		return { root, workspace, home, tools, ctx };
	}

	function cleanupToolStorageFixture(root: string): void {
		resetToolStoragePlanCache();
		resetToolStorageWarnings();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}

	it("tool storage: creates and writes detected uv cache/python roots while preserving the outside boundary", async () => {
		const inheritedRuntime = realpathSync.native(mkdtempSync(join(process.cwd(), ".sbx-int-inherited-runtime-")));
		chmodSync(inheritedRuntime, 0o700);
		vi.stubEnv("XDG_RUNTIME_DIR", inheritedRuntime);
		const fixture = toolStorageFixture();
		try {
			const cache = join(fixture.home, ".cache", "uv");
			const python = join(fixture.home, ".local", "share", "uv", "python");
			expect(existsSync(cache)).toBe(false);
			expect(existsSync(python)).toBe(false);
			const write = (path: string) => {
				const script = 'require("node:fs").writeFileSync(process.argv[1], "ok")';
				return fixture.tools.bash.execute("tool-storage-write", {
					command: `${shellQuote(process.execPath)} -e ${shellQuote(script)} ${shellQuote(path)}`,
				}, undefined, undefined, fixture.ctx as never);
			};
			await write(join(cache, "probe.txt"));
			await write(join(python, "probe.txt"));
			expect(readFileSync(join(cache, "probe.txt"), "utf-8")).toBe("ok");
			expect(readFileSync(join(python, "probe.txt"), "utf-8")).toBe("ok");

			const outside = join(fixture.root, "outside");
			mkdirSync(outside);
			const denied = await write(join(outside, "probe.txt"));
			expect(toolText(denied)).toContain("[sandbox: file access denied under workspace-write mode]");
			// No inherited cache/runtime override may move a generated root outside the fixture.
			for (const root of getToolStoragePlan(fixture.workspace).roots) {
				const rel = relative(fixture.root, root.path);
				expect(rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)), root.path).toBe(true);
			}
		} finally {
			cleanupToolStorageFixture(fixture.root);
			rmSync(inheritedRuntime, { recursive: true, force: true });
		}
	}, 60_000);

	it("tool storage: read-only execution does not create detected roots", async () => {
		const fixture = toolStorageFixture("read-only");
		try {
			await fixture.tools.bash.execute("tool-storage-ro", { command: "true" }, undefined, undefined, fixture.ctx as never);
			expect(existsSync(join(fixture.home, ".cache", "uv"))).toBe(false);
			expect(existsSync(join(fixture.home, ".local", "share", "uv", "python"))).toBe(false);
		} finally {
			cleanupToolStorageFixture(fixture.root);
		}
	}, 60_000);

	it("read-only: 额外可写根也不可写", async () => {
		const extra = repoTreeExtraDir();
		try {
			const ops = createSandboxBashOps({ mode: "read-only", workspaceRoot: ws, extraRoots: [extra], hooks });
			const chunks: Buffer[] = [];
			const denied = await ops.exec(`touch ${extra}/ro.txt`, ws, { onData: (b) => chunks.push(b) });
			expect(denied.exitCode).not.toBe(0);
			expect(chunks.map((c) => c.toString()).join("")).toContain("[sandbox: file access denied under read-only mode]");
		} finally {
			rmSync(extra, { recursive: true, force: true });
		}
	}, 60_000);
}, 60_000);
