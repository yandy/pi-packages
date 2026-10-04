// pi-sandbox/tests/win32/diagnose-script.test.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
	new URL(
		"../../resources/skills/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1",
		import.meta.url,
	),
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

function shell(program: string, args: readonly string[]) {
	const result = spawnSync(program, args, { encoding: "utf8", timeout: 120_000 });
	// spawn 失败（如 PATH 上没有该 PowerShell）时 result.error 必须进入 output，否则断言只剩 “expected null to be 0”。
	const spawnError = result.error === undefined ? "" : `[spawn error: ${result.error.message}]`;
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}${spawnError}` };
}

function runScript(args: readonly string[]) {
	return shell(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args]);
}

/** 写一条 deny ACE（受托人 = 包 SID）。真机实证：`icacls /deny "*SID:…"` 在本机会**静默不生效**
 * （status 0 但 SDDL 里没有该 ACE；由脚本 collateral 检查通过反推出写入时就不存在）。
 * .NET 直接写安全描述符不经过 icacls 的映射，且与本仓已在真机验证可写的能力 ACE 同一条路径；
 * 写完立即回读断言，失败点落在夹具而不是“脚本没保住一个不存在的 ACE”。 */
function addPackageDenyAce(path: string): void {
	const literal = psLiteral(path);
	const command = [
		`$sid = [System.Security.Principal.SecurityIdentifier]::new('${PACKAGE_SID}')`,
		`$acl = Get-Acl -LiteralPath ${literal}`,
		"$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'ReadAndExecute', 'ContainerInherit, ObjectInherit', 'None', 'Deny'))",
		`Set-Acl -LiteralPath ${literal} -AclObject $acl`,
	].join("; ");
	const result = shell(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
	expect(result.status, result.output).toBe(0);
	expect(sddl(path)).toMatch(/\(D;[A-Z]*;[^)]*;;;S-1-15-2-1234567890-1234567890\)/u);
}

/** PowerShell 字面量（单引号内翻倍）——`-Command` 拼接用。 */
function psLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
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
	// 这两条自检读 icacls 文本而非 sddl()：`(RX)`/`(F)` 是 icacls 的符号形（不随语言环境变化），
	// SDDL 里权限位是十六进制掩码（RX = 0x1200a9、F = 0x1f01ff），`(RX)` 永不出现——sddl() 改用
	// Get-Acl 的 SDDL 后若沿用原断言，真机第二跑已绿的用例 2/7 会因夹具自检而回归。
	const icaclsText = shell("icacls", [path]).output;
	expect(icaclsText).toContain("(RX)");
	expect(icaclsText).not.toContain("(F)");
}

/** 用 `Get-Acl` 的 SDDL（locale 无关、SID 形式，能直接断言 `(D;` 拒绝 ACE）而不是 icacls 的本地化输出。 */
function sddl(path: string): string {
	const result = shell(PS, [
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		`(Get-Acl -LiteralPath ${psLiteral(path)}).Sddl`,
	]);
	expect(result.status, result.output).toBe(0);
	return result.output.trim();
}

let scratch: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "pi-sbx-acl-"));
});
afterEach(() => {
	// `/inheritance:r` 造出的受保护 DACL 会让删除直接 EPERM（不是瞬态锁）：先把整棵树的 ACE
	// 复位为继承（用户是所有者，有隐式 WRITE_DAC），再删。
	shell("icacls", [scratch, "/reset", "/T", "/C", "/Q"]);
	rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(process.platform !== "win32")("diagnose-windows-sandbox-acl script", { timeout: 120_000 }, () => {
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

	it("removes package allow entries while preserving deny entries and other allow entries", () => {
		const target = join(scratch, "denied");
		shell("cmd", ["/c", "mkdir", target]);
		// DENY 的受托人用**同一个包 SID**（不是当前用户）：真机证明“受托人 = 当前用户”的 deny 只要含
		// SYNCHRONIZE（icacls 的 (W)/(D) 都会展开出 S）就会打掉 CreateFileW(FILE_WRITE_DAC) 的探测；
		// 而包 SID 的 deny 对用户的访问检查无影响，同时钉住脚本“同 SID 的 deny 不得被当成冲突移除”。
		const otherAllow = shell("icacls", [target, "/grant", "*S-1-5-32-545:(OI)(CI)(RX)"]);
		expect(otherAllow.status, otherAllow.output).toBe(0);
		addPackageAce(target); // 同 SID 的 allow：移除路径必须执行且只移除 allow
		// deny 放在最后写：icacls 的 grant 会重写整个 DACL，排在它前面可能被重新推导/固化的写盘扰动；
		// 同时 icacls /deny 在本机静默不生效（status 0 但无 ACE），所以用 .NET 写并自检。
		addPackageDenyAce(target);
		const run = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", join(scratch, "out")]);
		expect(run.status, run.output).toBe(0);
		const after = sddl(target);
		// SDDL 里按 ACE 类型区分：同 SID 的 allow 必须消失、同 SID 的 deny 必须原样保留。
		expect(after).not.toMatch(/\(A;[A-Z]*;[^)]*;;;S-1-15-2-1234567890-1234567890\)/u);
		expect(after).toMatch(/\(D;[A-Z]*;[^)]*;;;S-1-15-2-1234567890-1234567890\)/u);
		expect(after).toMatch(/\(A;[A-Z]*;[^)]*;;;(?:BU|S-1-5-32-545)\)/u); // 其它允许 ACE 原样保留（SDDL 会把该 well-known SID 别名成 BU）
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
		const out = join(scratch, "out");
		// Node 传 env 覆写在真机上实测不生效（子进程仍读到 C:\Program Files）：改为在同一个
		// PowerShell 进程内先设 `$env:ProgramFiles` 再调用脚本；`exit $LASTEXITCODE` 透传退出码。
		const run = shell(PS, [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			`$env:ProgramFiles = ${psLiteral(scratch)}; & ${psLiteral(SCRIPT)} -Path ${psLiteral(managed)} -AllowRoot ${psLiteral(scratch)} -Out ${psLiteral(out)}; exit $LASTEXITCODE`,
		]);
		expect(run.status, run.output).toBe(2);
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
		// `-File` 下 `-Path a b` 不会绑成数组（`b` 会被当位置参数绑给 -AllowRoot，报“参数指定多次”
		// 并由 PowerShell 退出 1，而非脚本的 ArgumentException）——用 `-Command` + `-Path 'a','b'` 显式数组。
		const restoreTwoPaths = shell(PS, [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			`& ${psLiteral(SCRIPT)} -Path ${psLiteral(target)},${psLiteral(join(target, "x"))} -AllowRoot ${psLiteral(scratch)} -Restore 'record.json'; exit $LASTEXITCODE`,
		]);
		expect(restoreTwoPaths.status, restoreTwoPaths.output).toBe(2);
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
