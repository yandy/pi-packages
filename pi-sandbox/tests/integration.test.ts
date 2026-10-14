import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandboxBashOps } from "../src/bash-ops";
import { resetRunnerCache, selectRunner } from "../src/runners";
import type { ConfinedSandboxMode } from "../src/policy";

resetRunnerCache();
const selected = selectRunner(5000);

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
		const ops = createSandboxBashOps({ mode, workspaceRoot: ws });
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
			const bare = createSandboxBashOps({ mode: "workspace-write", workspaceRoot: ws });
			const bareChunks: Buffer[] = [];
			const bareDenied = await bare.exec(`touch ${extra}/ok.txt`, ws, { onData: (b) => bareChunks.push(b) });
			expect(bareDenied.exitCode).not.toBe(0);
			expect(bareChunks.map((c) => c.toString()).join("")).toContain(
				"[sandbox: file access denied under workspace-write mode]",
			);

			// ……经 extraRoots 授予后同一条命令成功：翻转结果的正是这次 grant。
			const ops = createSandboxBashOps({ mode: "workspace-write", workspaceRoot: ws, extraRoots: [extra] });
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

	it("read-only: 额外可写根也不可写", async () => {
		const extra = repoTreeExtraDir();
		try {
			const ops = createSandboxBashOps({ mode: "read-only", workspaceRoot: ws, extraRoots: [extra] });
			const chunks: Buffer[] = [];
			const denied = await ops.exec(`touch ${extra}/ro.txt`, ws, { onData: (b) => chunks.push(b) });
			expect(denied.exitCode).not.toBe(0);
			expect(chunks.map((c) => c.toString()).join("")).toContain("[sandbox: file access denied under read-only mode]");
		} finally {
			rmSync(extra, { recursive: true, force: true });
		}
	}, 60_000);
}, 60_000);
