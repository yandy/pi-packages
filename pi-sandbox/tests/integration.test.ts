import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/**
 * 额外可写根的真机夹具：一个**既不在 /tmp（bwrap 已 rw bind）也不在工作区**的目录，
 * 否则“写成功了”证明不了是 extraRoots 的功劳。只能用 $HOME 下的夹具，而 HOME 不可写时
 * （例如本套件自己就跑在 pi-sandbox 的 workspace-write 里）夹具建不起来。
 * 在**模块层**求值（而不是 beforeAll）是为了让 `it.skipIf` 在收集期就能看到结论：
 * 否则用例会静默空跑并报绿。夹具建不起来时 argv 形状仍由 runners/confine 单测逐字钉住。
 */
const homeGrantedRoot: string | null = (() => {
	if (skipConfinedBashCases) return null;
	try {
		const candidate = join(homedir(), `.sbx-int-extra-${process.pid}`);
		mkdirSync(candidate, { recursive: true });
		writeFileSync(join(candidate, "probe"), "x");
		return candidate;
	} catch {
		return null;
	}
})();
const homeDeniedFile = join(homedir(), `.sbx-int-denied-${process.pid}`);

describe.skipIf(skipConfinedBashCases)(`real confinement via ${selected.runner}`, () => {
	let ws: string;

	beforeAll(() => {
		ws = realpathSync.native(mkdtempSync(join(tmpdir(), "sbx-int-")));
	});
	afterAll(() => {
		rmSync(ws, { recursive: true, force: true });
		if (homeGrantedRoot !== null) rmSync(homeGrantedRoot, { recursive: true, force: true });
		rmSync(homeDeniedFile, { force: true }); // 仅在沙箱失效时才会存在，尽力清理
		rmSync(`/etc/sbx-escape-${process.pid}`, { force: true }); // 仅在沙箱失效且 root 运行时才会存在，尽力清理
	});

	async function run(mode: ConfinedSandboxMode, command: string, extraRoots?: readonly string[]) {
		const ops = createSandboxBashOps({ mode, workspaceRoot: ws, extraRoots });
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

	it("workspace-write: a path outside /tmp and the workspace is denied by default", async () => {
		// 目标是 $HOME 下的文件名而不是 <不存在目录>/x：classifyDenial 靠后端的 stderr 方言子串判拒绝，
		// 而 ENOENT 报的是 "No such file or directory"，不含任何方言 → 不下发标记与提示
		//（真机实测，已记入 spec §9）。父目录必然存在，拒绝就一定是 EROFS。
		const r = await run("workspace-write", `touch '${homeDeniedFile}'`);
		expect(r.exitCode).not.toBe(0);
		expect(r.text).toContain("[sandbox: file access denied under workspace-write mode]");
	});

	// Ruling 6：拒绝后下发的提示必须带上“不提权的出路”，否则模型只能往 danger-full-access 升。
	it("the denial hint carries the cache-redirect recipe for commands", async () => {
		const r = await run("workspace-write", `touch '${homeDeniedFile}'`);
		expect(r.exitCode).not.toBe(0);
		expect(r.text).toContain("UV_CACHE_DIR=/tmp/uv-cache");
		expect(r.text).toContain("pnpm install --store-dir /tmp/pnpm-store");
	});

	it.skipIf(homeGrantedRoot === null)("workspace-write: an extra root outside /tmp becomes writable (real bind)", async () => {
		// 自证断言对：同一路径**不**配额外根时必须被拒，否则本用例证明不了 bind 的功劳。
		const denied = await run("workspace-write", `touch '${homeGrantedRoot}/control.txt'`);
		expect(denied.exitCode).not.toBe(0);
		expect(denied.text).toContain("[sandbox: file access denied under workspace-write mode]");

		const r = await run("workspace-write", `touch '${homeGrantedRoot}/granted.txt' && echo granted`, [homeGrantedRoot]);
		expect(r.text).toContain("granted");
		expect(r.exitCode).toBe(0);
	});

	it.skipIf(homeGrantedRoot === null)("workspace-write: an extra root does not widen anything else", async () => {
		const r = await run("workspace-write", `touch '${homeDeniedFile}'`, [homeGrantedRoot]);
		expect(r.exitCode).not.toBe(0);
		expect(r.text).toContain("[sandbox: file access denied under workspace-write mode]");
	});

	it.skipIf(homeGrantedRoot === null)("read-only: extra roots grant nothing", async () => {
		const r = await run("read-only", `touch '${homeGrantedRoot}/ro.txt'`, [homeGrantedRoot]);
		expect(r.exitCode).not.toBe(0);
		expect(r.text).toContain("[sandbox: file access denied under read-only mode]");
	});
}, 60_000);

/**
 * 受保护路径的真机验证（spec 2026-10-14-protected-project-config）。
 * 只有 bwrap 链上「挖洞」才成立，所以按 runner 门控；landlock 表达不了 deny-within-allow，
 * 那一条缺口由下面的「residual gap」用例如实钉住，而不是假装它被挡住了。
 */
describe.skipIf(skipConfinedBashCases)(`protected config dir via ${selected.runner}`, () => {
	let ws: string;
	let pi: string;
	const isBwrap = selected.runner === "bwrap";

	beforeAll(() => {
		ws = realpathSync.native(mkdtempSync(join(tmpdir(), "sbx-prot-")));
		pi = join(ws, ".pi");
	});
	afterAll(() => { rmSync(ws, { recursive: true, force: true }); });

	async function run(command: string) {
		const ops = createSandboxBashOps({ mode: "workspace-write", workspaceRoot: ws });
		const chunks: Buffer[] = [];
		const result = await ops.exec(command, ws, { onData: (b) => chunks.push(b) });
		return { ...result, text: chunks.map((c) => c.toString()).join("") };
	}

	it("denies a write into <ws>/.pi and carries the marker + escalation hint", async () => {
		if (!isBwrap) return; // landlock 挖不了洞，见下一条
		mkdirSync(join(pi, "agents"), { recursive: true });
		const r = await run(`touch '${pi}/agents/evil.md'`);
		expect(r.exitCode).not.toBe(0);
		expect(r.text).toContain("[sandbox: file access denied under workspace-write mode]");
		expect(r.text).toContain("[sandbox: escalation available");
	});

	it("keeps ordinary workspace writes working next to the carve-out", async () => {
		if (!isBwrap) return;
		mkdirSync(join(pi, "agents"), { recursive: true });
		const r = await run("touch normal.txt && echo ok");
		expect(r.exitCode).toBe(0);
		expect(r.text).toContain("ok");
	});

	/**
	 * A 方案的残余缺口，如实钉住：`.pi` 不存在时 bwrap 挖不了洞（`--ro-bind` 对缺失源硬失败），
	 * 于是 bash 仍能从零创建它。围栏侧（write/edit）全平台拦住这条路，覆盖见 tools.test.ts。
	 * 这条用例是**缺口存在的证据**，不是期望行为——将来若闭合了缺口，它应当被改成断言拒绝。
	 */
	it("residual gap: bash can still create .pi from scratch when it does not exist", async () => {
		if (!isBwrap) return;
		const fresh = realpathSync.native(mkdtempSync(join(tmpdir(), "sbx-prot-fresh-")));
		try {
			const ops = createSandboxBashOps({ mode: "workspace-write", workspaceRoot: fresh });
			const chunks: Buffer[] = [];
			const r = await ops.exec(`mkdir -p '${fresh}/.pi/agents' && touch '${fresh}/.pi/agents/x.md' && echo created`, fresh, {
				onData: (b) => chunks.push(b),
			});
			expect(r.exitCode).toBe(0);
			expect(chunks.map((c) => c.toString()).join("")).toContain("created");
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});
}, 60_000);
