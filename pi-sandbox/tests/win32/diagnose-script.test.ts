// pi-sandbox/tests/win32/diagnose-script.test.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
	new URL("../../skills/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1", import.meta.url),
);
const PACKAGE_SID = "S-1-15-2-1234567890-1234567890";

/** pwsh when installed, Windows PowerShell 5.1 otherwise（与 e2e 套件同策略：目标机器可能只有 5.1）。 */
function resolvePowerShell(): string {
	const pathDirs = (process.env.PATH ?? "").split(delimiter);
	for (const name of ["pwsh.exe", "powershell.exe"]) {
		for (const dir of pathDirs) {
			if (dir.length > 0 && existsSync(join(dir, name))) return join(dir, name);
		}
	}
	return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const PS = process.env.PI_SANDBOX_PS ?? (process.platform === "win32" ? resolvePowerShell() : "pwsh");

/** 当前用户的 `[域\]名`：域环境下裸 USERNAME 可能解析到本地账户。 */
function currentUser(): string {
	return `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;
}

function shell(program: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
	const result = spawnSync(program, args, {
		encoding: "utf8",
		timeout: 120_000,
		env: env === undefined ? process.env : { ...process.env, ...env },
	});
	// spawn 失败（如 PATH 上没有该 PowerShell）时 result.error 必须进入 output，否则断言只剩 “expected null to be 0”。
	const spawnError = result.error === undefined ? "" : `[spawn error: ${result.error.message}]`;
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}${spawnError}` };
}

function runScript(args: readonly string[], env?: NodeJS.ProcessEnv) {
	return shell(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args], env);
}

function reports(output: string) {
	return output
		.split(/\r?\n/u)
		.filter((line) => line.startsWith("REPORT "))
		.map(
			(line) =>
				JSON.parse(line.slice("REPORT ".length)) as {
					kind?: string;
					operation?: string;
					status?: string;
					details?: Record<string, unknown>;
				},
		);
}

function recap(output: string) {
	const line = output.split(/\r?\n/u).find((l) => l.startsWith("RECAP "));
	return line === undefined ? undefined : (JSON.parse(line.slice("RECAP ".length)) as Record<string, unknown>);
}

/** `nextAction` 在 summary 报告记录的 details 里，不在 RECAP 里（RECAP 只有 verdicts/changes/verifications/refusals/scans/report）。
 * 判别字段是 `kind`：`Write-Report` 的参数序是 (Kind, Operation, Target, ...)，summary 记录的 `operation` 装的是 mode。 */
function nextAction(output: string): unknown {
	return reports(output).find((record) => record.kind === "summary")?.details?.nextAction;
}

/** RECAP.verdicts 是对象数组：`{ path, verdict, writeDac, writeOwner, packageObjects }`。 */
function verdicts(output: string): string[] {
	const value = recap(output)?.verdicts;
	return Array.isArray(value) ? value.map((entry) => String((entry as { verdict?: unknown }).verdict)) : [];
}

/** 给一个对象加显式包允许 ACE（用真实的 S-1-15-2-* 形态）。 */
function addPackageAce(path: string): void {
	const icacls = shell("icacls", [path, "/grant", `*${PACKAGE_SID}:(OI)(CI)(RX)`]);
	expect(icacls.status, icacls.output).toBe(0);
}

/** 制造“需要补授权”的目标：切断继承、只给当前用户 RX——只剩**所有者隐式 WRITE_DAC**，恰好落在脚本的 grant 分支。
 * 不能用 `icacls /remove`：它只删显式 ACE，继承的 FullControl 仍在，目标看起来完全健康。 */
function needsGrant(path: string): void {
	const icacls = shell("icacls", [path, "/inheritance:r", "/grant", `${currentUser()}:(OI)(CI)(RX)`]);
	expect(icacls.status, icacls.output).toBe(0);
	// 夹具真的生效：只剩 RX 且继承的 FullControl 已切断，否则用例会以错误的原因通过/失败。
	expect(sddl(path)).toContain("(RX)");
	expect(sddl(path)).not.toContain("(F)");
}

function sddl(path: string): string {
	return shell("icacls", [path]).output;
}

let scratch: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "pi-sbx-acl-"));
});
afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")("diagnose-windows-sandbox-acl script", () => {
	it("reports NOT_THIS_CLASS and changes nothing on a healthy directory", () => {
		const target = join(scratch, "healthy");
		shell("cmd", ["/c", "mkdir", target]);
		const before = sddl(target);
		const run = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", join(scratch, "out")]);
		expect(run.status).toBe(0);
		expect(verdicts(run.output)).toContain("NOT_THIS_CLASS");
		expect(sddl(target)).toBe(before);
	});

	it("grants the signed-in user full control when WRITE_OWNER is missing and emits a recovery pair", () => {
		const target = join(scratch, "locked");
		shell("cmd", ["/c", "mkdir", target]);
		needsGrant(target);
		const out = join(scratch, "out");
		const run = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", out]);
		expect(run.status).toBe(0);
		expect(nextAction(run.output), run.output).toBe("verify_original_confined_operation");
		const files = readdirSync(out);
		expect(files.some((f) => /^acl-backup-.*\.json$/u.test(f))).toBe(true);
		expect(files.some((f) => /^acl-backup-.*\.ps1$/u.test(f))).toBe(true);
		expect(run.output).toContain("ROLLBACK ");
	});

	it("removes an explicit package allow entry at its source", () => {
		const target = join(scratch, "packaged");
		shell("cmd", ["/c", "mkdir", target]);
		addPackageAce(target);
		const run = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", join(scratch, "out")]);
		expect(run.status).toBe(0);
		expect(sddl(target)).not.toContain("S-1-15-2-1234567890");
	});

	it("removes package allow entries while preserving deny entries and pi-sandbox capability SIDs", () => {
		const target = join(scratch, "denied");
		shell("cmd", ["/c", "mkdir", target]);
		const deny = shell("icacls", [target, "/deny", `${currentUser()}:(OI)(CI)(W)`]);
		expect(deny.status, deny.output).toBe(0);
		const capability = shell("icacls", [target, "/grant", "*S-1-4-105015370-174601073:(OI)(CI)(M)"]);
		expect(capability.status, capability.output).toBe(0);
		addPackageAce(target); // 必须真的有包 ACE：否则移除路径不执行，本用例什么都不验证
		const run = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", join(scratch, "out")]);
		expect(run.status).toBe(0);
		const after = sddl(target);
		expect(after).not.toContain("S-1-15-2-1234567890");
		expect(after).toMatch(/\(DENY\)/i);
		expect(after).toContain("S-1-4-105015370-174601073");
	});

	it("refuses a package source outside -AllowRoot before changing anything and exits 2", () => {
		// 拒绝只在“包 ACE 来源”上触发（Get-RepairRefusal 只作用于 packageTargets 与 grant 候选）：
		// 把包 ACE 放在请求路径的**祖先**（-AllowRoot 之外），才能得到 REPAIR_REFUSED → exit 2。
		const outer = join(scratch, "outer");
		const inner = join(outer, "inner");
		shell("cmd", ["/c", "mkdir", inner]);
		addPackageAce(outer);
		const before = sddl(outer);
		const run = runScript(["-Path", inner, "-AllowRoot", inner, "-Out", join(scratch, "out")]);
		expect(run.status).toBe(2);
		expect(run.output).toContain("REPAIR_REFUSED");
		expect(sddl(outer)).toBe(before);
	});

	it("refuses the managed application tree inside -AllowRoot", () => {
		// Test-DangerousRoot 只认真正的受保护根（%ProgramFiles%\WindowsApps 等）——临时目录里的
		// 同名目录不触发，所以把子进程的 ProgramFiles 覆写为 scratch，让脚本自身的判定生效。
		const managed = join(scratch, "WindowsApps", "app");
		shell("cmd", ["/c", "mkdir", managed]);
		addPackageAce(managed);
		const before = sddl(managed);
		const run = runScript(["-Path", managed, "-AllowRoot", scratch, "-Out", join(scratch, "out")], {
			ProgramFiles: scratch,
		});
		expect(run.status).toBe(2);
		expect(run.output).toContain("REPAIR_REFUSED");
		expect(nextAction(run.output), run.output).toBe("stop");
		expect(sddl(managed)).toBe(before);
	});

	it("restores a saved DACL from the recovery record and the printed ROLLBACK command", () => {
		const target = join(scratch, "restore-me");
		shell("cmd", ["/c", "mkdir", target]);
		needsGrant(target);
		const before = sddl(target);
		const out = join(scratch, "out");
		const repair = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", out]);
		expect(repair.status).toBe(0);
		expect(sddl(target)).not.toBe(before); // 修复真的改了 DACL，否则下面的还原断言没有意义
		const rollbackLine = repair.output.split(/\r?\n/u).find((l) => l.startsWith("ROLLBACK "));
		expect(rollbackLine).toBeDefined();
		// 真正执行打印出的 ROLLBACK 命令（用户会粘贴的那一行），而不是重复一遍 repair argv。
		const viaCommand = shell(PS, ["-NoProfile", "-Command", (rollbackLine as string).slice("ROLLBACK ".length)]);
		expect(viaCommand.status, viaCommand.output).toBe(0);
		expect(sddl(target)).toBe(before);
		// 记录文件本身也能直接 -Restore（RECAP/记录契约）。
		const record = readdirSync(out).find((f) => /^acl-backup-.*\.json$/u.test(f));
		expect(record).toBeDefined();
		const restored = runScript(["-Path", target, "-AllowRoot", scratch, "-Restore", join(out, record as string)]);
		expect(restored.status).toBe(0);
		expect(sddl(target)).toBe(before);
	});

	it("rejects a missing -AllowRoot, a repair without -Out, and -Restore with two paths", () => {
		const target = join(scratch, "usage");
		shell("cmd", ["/c", "mkdir", target]);
		const missingRoot = runScript(["-Path", target, "-Out", join(scratch, "out")]);
		expect(missingRoot.status).toBe(2);
		expect(missingRoot.output).toContain("-AllowRoot");
		const missingOut = runScript(["-Path", target, "-AllowRoot", scratch]);
		expect(missingOut.status).toBe(2);
		expect(missingOut.output).toContain("-Out");
		const restoreTwoPaths = runScript([
			"-Path",
			target,
			join(target, "x"),
			"-AllowRoot",
			scratch,
			"-Restore",
			"record.json",
		]);
		expect(restoreTwoPaths.status).toBe(2);
		expect(restoreTwoPaths.output).toContain("exactly one -Path");
	});

	it("refuses a package source reached through a junction", () => {
		const outside = join(scratch, "outside-junction");
		const link = join(scratch, "link");
		shell("cmd", ["/c", "mkdir", outside]);
		shell("cmd", ["/c", "mklink", "/J", link, outside]);
		// 包 ACE 放在 junction **背后**的真实目录：祖先链必穿过 reparse point → 必须拒绝。
		// 不依赖“icacls 把 ACL 写在链接自身还是目标上”这一未定语义。
		const sub = join(link, "sub");
		shell("cmd", ["/c", "mkdir", sub]);
		addPackageAce(sub);
		const before = sddl(sub);
		const run = runScript(["-Path", sub, "-AllowRoot", scratch, "-Out", join(scratch, "out")]);
		expect(run.status).toBe(2);
		expect(run.output).toContain("REPAIR_REFUSED");
		expect(nextAction(run.output), run.output).toBe("stop");
		expect(sddl(sub)).toBe(before);
	});

	it("writes one JSONL report per run under -Out", () => {
		const target = join(scratch, "report");
		shell("cmd", ["/c", "mkdir", target]);
		const out = join(scratch, "out");
		const run = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", out]);
		expect(run.status).toBe(0);
		const found = readdirSync(out).filter((f) => /^acl-report-.*\.jsonl$/u.test(f));
		expect(found).toHaveLength(1);
		expect(existsSync(join(out, found[0] as string))).toBe(true);
	});
});
