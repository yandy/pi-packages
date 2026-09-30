import { canonicalPath, type ConfinedSandboxMode } from "./policy";
import {
	bwrapProfileArgs,
	LAUNCHER_BIN,
	LAUNCHER_FAILURE_EXIT,
	runnerInvocation,
	selectRunner,
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
} as const;

export const RUNNER_FAILURE_RULES = {
	bwrap: [{ fatalSignatures: ["bwrap: "] }],
	landlock: [{
		allowedExitCodes: [LAUNCHER_FAILURE_EXIT],
		fatalSignatures: [`${LAUNCHER_BIN}: `],
		informationalLines: [`${LAUNCHER_BIN}: partial enforcement (older Landlock ABI)`],
	}],
	seatbelt: [{ fatalSignatures: ["sandbox-exec: "] }],
} as const satisfies Record<"bwrap" | "landlock" | "seatbelt", readonly RunnerFailureRule[]>;

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
	return {
		argv: [...runnerInvocation(selected, policy, opts.hooks), "--", ...argv],
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
