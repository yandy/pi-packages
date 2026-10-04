import { canonicalPath, type ConfinedSandboxMode, type SandboxMode } from "./policy";
import {
	bwrapProfileArgs,
	LAUNCHER_BIN,
	LAUNCHER_FAILURE_EXIT,
	runnerInvocation,
	selectRunner,
	windowsAclAvailability,
	type RunnerHooks,
	type RunnerPolicy,
	type SandboxEnforcement,
	type SelectedRunner,
} from "./runners";

export interface RunnerFailureRule {
	/** 非零 exit code 门控；缺省允许任何非零 exit。 */
	allowedExitCodes?: readonly number[];
	/** 标识 runner 致命诊断的非空子串（一行内）。 */
	fatalSignatures: readonly string[];
	/** 在 fatal 匹配前按整行相等剔除的良性 stderr 行。 */
	informationalLines?: readonly string[];
}

export interface ConfinedArgv {
	argv: string[];
	enforcement: SandboxEnforcement;
	/** 该后端的拒绝方言：被沙箱拒绝的文件效果在该后端下产生的 stderr 子串。 */
	denialSignatures: readonly string[];
	runnerFailureRules: readonly RunnerFailureRule[];
}

/** fail-closed：命令没有被执行。逃生门是显式配置 danger-full-access。 */
export class SandboxUnavailableError extends Error {
	constructor(mode: ConfinedSandboxMode, detail?: string) {
		super(
			detail
				? `SANDBOX_UNAVAILABLE (${mode}): sandbox runner failed before the command ran: ${detail}`
				: `SANDBOX_UNAVAILABLE (${mode}): no usable sandbox runner on this host; the command was NOT executed. Install bwrap (Linux) or set mode "danger-full-access" explicitly to run unsandboxed.`,
		);
		this.name = "SandboxUnavailableError";
	}
}

/** 每个后端自己的拒绝方言（禁止跨后端并集，spec §6）。 */
export const DENIAL_SIGNATURES = {
	bwrap: ["read-only file system"],
	landlock: ["permission denied"],
	seatbelt: ["operation not permitted"],
	runnerCommand: ["read-only file system", "permission denied"],
	// 移植契约（Ruling 6）：覆盖 cmd（Access is denied）、pwsh/.NET（Access to the path…）、
	// Node EACCES/EPERM 与 git-bash（permission denied / operation not permitted）四种方言。
	"windows-acl": ["access is denied", "access to the path", "permission denied", "operation not permitted"],
} as const;

export const RUNNER_FAILURE_RULES = {
	bwrap: [{ fatalSignatures: ["bwrap: "] }],
	landlock: [{
		allowedExitCodes: [LAUNCHER_FAILURE_EXIT],
		fatalSignatures: [`${LAUNCHER_BIN}: `],
		informationalLines: [`${LAUNCHER_BIN}: partial enforcement (older Landlock ABI)`],
	}],
	seatbelt: [{ fatalSignatures: ["sandbox-exec: "] }],
	// 移植契约（Ruling 7）：exit 127 门控 + runner 前缀签名，避免把受限命令自己打印的
	// 同名字样误判为 runner 失败（命令确实跑过时绝不判 runner 失败）。
	"windows-acl": [{ allowedExitCodes: [127], fatalSignatures: ["windows-acl-run: "] }],
} as const satisfies Record<"bwrap" | "landlock" | "seatbelt" | "windows-acl", readonly RunnerFailureRule[]>;

/** Windows 受限模式只支持 pwsh（Ruling 2）：bash 在任何受限模式下拒绝执行，绝不 spawn。
 *  纵深防御：本包在 win32 上把 bash 注册为 `exposure: "hidden"`（D3 第三版：模型不可达、也无法被
 *  `defaultTools`/`--tools` 命名激活），故正常路径下模型根本不会看到 bash；本类仍保留为**拒绝壳**，
 *  以防未来宿主改变激活语义或有人直接调用该工具定义。
 *  文案只给**有效**指引：`defaultTools` 的 `-bash` 去不掉扩展注册的工具——所以不再教用户改
 *  `defaultTools`，只说明“用 powershell、bash 保持 fail-closed、danger-full-access 是唯一显式逃生门”。 */
export class UnsupportedWindowsShellError extends Error {
	constructor(shell: string) {
		super(
			`[sandbox: ${shell} is not supported on Windows]\n` +
			`pi-sandbox confines Windows commands through the powershell tool only (requires pi >= 1.0.0); use the powershell tool instead of bash — the command was NOT executed.\n` +
			`bash stays fail-closed on Windows: enabling it explicitly does not unconfine it.\n` +
			`"danger-full-access" remains the only explicit bypass.`,
		);
		this.name = "UnsupportedWindowsShellError";
	}
}

/**
 * Windows 受限模式只支持 pwsh（Ruling 2）：bash 在任何受限模式下拒绝执行，绝不 spawn。
 * @param shell - 待执行的 shell 名（`"bash"` / `"powershell"`）。
 * @param platform - 宿平台（注入点）。
 * @param mode - 本次调用解析出的生效模式。
 */
export function assertShellAllowed(shell: string, platform: string, mode: SandboxMode): void {
	if (platform === "win32" && shell === "bash" && mode !== "danger-full-access") {
		throw new UnsupportedWindowsShellError(shell);
	}
}

export interface ConfineOptions {
	/** 预解析的 runner（测试注入 / 调用方缓存）；缺省时走 selectRunner。 */
	selected?: SelectedRunner;
	runnerCommand?: string[] | null;
	runnerFailureSignatures?: string[] | null;
	probeTimeoutMs?: number;
	hooks?: RunnerHooks;
}

/**
 * 把 argv 包装进选中 runner 的策略调用（spec §2）。workspaceRoot 在此统一
 * canonical 化一次，profile 构造器保持纯净。
 */
export function confine(
	argv: readonly string[],
	mode: ConfinedSandboxMode,
	workspaceRoot: string,
	opts: ConfineOptions = {},
): ConfinedArgv {
	const policy: RunnerPolicy = { mode, workspaceRoot: canonicalPath(workspaceRoot) };

	if (opts.runnerCommand && opts.runnerCommand.length > 0) {
		return {
			argv: [...opts.runnerCommand, ...bwrapProfileArgs(policy), "--", ...argv],
			enforcement: "full",
			denialSignatures: DENIAL_SIGNATURES.runnerCommand,
			runnerFailureRules: [{ fatalSignatures: opts.runnerFailureSignatures ?? [] }],
		};
	}

	const selected = opts.selected ?? selectRunner(opts.probeTimeoutMs ?? 5000, opts.hooks);
	if (selected.runner === "unavailable") throw new SandboxUnavailableError(mode);

	// win32 的可用性只解析一次并透传给 runnerInvocation（Task 9 约定）；
	// 注入即权威：hook 存在时其返回值就是结论（含显式 undefined），绝不回退真实探测。
	// 不可解析即 fail-closed 抛 SandboxUnavailableError，绝不构造跑不起来的 argv。
	let availability: { node: string; runner: string } | undefined;
	if (selected.runner === "windows-acl") {
		const hooks = opts.hooks ?? {};
		const injectedRung = hooks.windowsAclRung;
		availability = injectedRung !== undefined ? injectedRung() : windowsAclAvailability(hooks);
		if (availability === undefined) {
			throw new SandboxUnavailableError(
				mode,
				"win32 runner is not resolvable (missing runner file, koffi, or a node executable)",
			);
		}
	}
	return {
		argv: [...runnerInvocation(selected, policy, opts.hooks, availability), "--", ...argv],
		enforcement: selected.enforcement,
		denialSignatures: DENIAL_SIGNATURES[selected.runner],
		runnerFailureRules: RUNNER_FAILURE_RULES[selected.runner],
	};
}

/**
 * runner 失败判定（命令根本没跑，优先于 denial 检查）。
 * exit 门控 → 大小写不敏感整行相等剔除 informationalLines → 剩余行内
 * 大小写不敏感子串匹配 fatalSignatures。返回命中的 fatal 行。
 * exitCode 为 0/null（成功或被信号杀）永不判为 runner 失败。
 */
export function classifyRunnerFailure(
	exitCode: number | null,
	stderr: string,
	rules: readonly RunnerFailureRule[],
): string | undefined {
	if (exitCode === null || exitCode === 0) return undefined;
	for (const rule of rules) {
		if (rule.allowedExitCodes && !rule.allowedExitCodes.includes(exitCode)) continue;
		const informational = new Set((rule.informationalLines ?? []).map((line) => line.toLowerCase()));
		for (const line of stderr.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			if (informational.has(trimmed.toLowerCase())) continue;
			const lower = trimmed.toLowerCase();
			for (const signature of rule.fatalSignatures) {
				if (lower.includes(signature.toLowerCase())) return trimmed;
			}
		}
	}
	return undefined;
}

/** denial 判定：非零 exit + 任一方言子串（大小写不敏感）出现在 stderr。 */
export function classifyDenial(exitCode: number | null, stderr: string, signatures: readonly string[]): boolean {
	if (exitCode === null || exitCode === 0) return false;
	const lower = stderr.toLowerCase();
	return signatures.some((signature) => lower.includes(signature.toLowerCase()));
}
