// pi-sandbox/tests/win32/diagnose-script.test.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
	new URL("../../skills/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1", import.meta.url),
);
const PS = process.env.PI_SANDBOX_PS ?? "pwsh";
const PACKAGE_SID = "S-1-15-2-1234567890-1234567890";

function shell(program: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
	const result = spawnSync(program, args, {
		encoding: "utf8",
		timeout: 120_000,
		env: env === undefined ? process.env : { ...process.env, ...env },
	});
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
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
	const user = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;
	const icacls = shell("icacls", [path, "/inheritance:r", "/grant", `${user}:(OI)(CI)(RX)`]);
	expect(icacls.status, icacls.output).toBe(0);
	expect(sddl(path)).toContain("(RX)"); // 夹具真的生效，避免用例以错误的原因通过/失败
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
		expect(nextAction(run.output)).toBe("verify_original_confined_operation");
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

	it("preserves deny entries and pi-sandbox capability SIDs", () => {
		const target = join(scratch, "denied");
		shell("cmd", ["/c", "mkdir", target]);
		shell("icacls", [target, "/deny", `${process.env.USERNAME ?? ""}:(OI)(CI)(W)`]);
		shell("icacls", [target, "/grant", "*S-1-4-105015370-174601073:(OI)(CI)(M)"]);
		runScript(["-Path", target, "-AllowRoot", scratch, "-Out", join(scratch, "out")]);
		const after = sddl(target);
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
		expect(nextAction(run.output)).toBe("stop");
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
		const record = readdirSync(out).find((f) => /^acl-backup-.*\.json$/u.test(f)) as string;
		const restored = runScript(["-Path", target, "-AllowRoot", scratch, "-Restore", join(out, record)]);
		expect(restored.status).toBe(0);
		expect(sddl(target)).toBe(before);
	});

	it("rejects a missing -AllowRoot, a repair without -Out, and -Restore with two paths", () => {
		const target = join(scratch, "usage");
		shell("cmd", ["/c", "mkdir", target]);
		expect(runScript(["-Path", target, "-Out", join(scratch, "out")]).status).toBe(2);
		expect(runScript(["-Path", target, "-AllowRoot", scratch]).status).toBe(2);
		expect(runScript(["-Path", target, join(target, "x"), "-AllowRoot", scratch, "-Restore", "record.json"]).status).toBe(
			2,
		);
	});

	it("refuses a junction that carries a package ACE", () => {
		const outside = join(scratch, "outside-junction");
		const link = join(scratch, "link");
		shell("cmd", ["/c", "mkdir", outside]);
		shell("cmd", ["/c", "mklink", "/J", link, outside]);
		addPackageAce(link); // 包 ACE 落在 reparse point 自身上：Get-RepairRefusal 必须拒绝
		const beforeLink = sddl(link);
		const beforeOutside = sddl(outside);
		const run = runScript(["-Path", link, "-AllowRoot", scratch, "-Out", join(scratch, "out")]);
		expect(run.status).toBe(2);
		expect(run.output).toContain("REPAIR_REFUSED");
		expect(nextAction(run.output)).toBe("stop");
		expect(sddl(link)).toBe(beforeLink);
		expect(sddl(outside)).toBe(beforeOutside);
	});

	it("writes one JSONL report per run under -Out", () => {
		const target = join(scratch, "report");
		shell("cmd", ["/c", "mkdir", target]);
		const out = join(scratch, "out");
		runScript(["-Path", target, "-AllowRoot", scratch, "-Out", out]);
		const report = readdirSync(out).find((f) => /^acl-report-.*\.jsonl$/u.test(f));
		expect(report).toBeDefined();
		expect(existsSync(join(out, report as string))).toBe(true);
	});
});
