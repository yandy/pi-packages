import { spawnSync } from "node:child_process";
import {
	grantArgs,
	LAUNCHER_BIN,
	LAUNCHER_FAILURE_EXIT,
	launcherPath,
	probe as probeLandlockLauncher,
} from "@deepseek-ai/node-addon-system/landlock-run";
import { writableRoots, type ConfinedSandboxMode } from "./policy";

export { LAUNCHER_BIN, LAUNCHER_FAILURE_EXIT };

export type SandboxEnforcement = "full" | "partial";
export type RunnerKind = "bwrap" | "landlock" | "seatbelt";
export type SelectedRunner = { runner: RunnerKind; enforcement: SandboxEnforcement } | { runner: "unavailable" };

export interface RunnerPolicy {
	mode: ConfinedSandboxMode;
	workspaceRoot: string;
}

/** 测试钩子：注入平台/probe/launcher 路径，单测不依赖真实 bwrap/landlock（deepseek 同款）。 */
export interface RunnerHooks {
	platform?: string;
	probeBwrap?: (timeoutMs: number) => boolean;
	probeLandlock?: (launcher: string, timeoutMs: number) => SandboxEnforcement | "unusable";
	launcherPath?: () => string;
	seatbeltExec?: string;
}

/**
 * bwrap mount profile（deepseek profiles.ts 语义）：宿主 / 全盘 ro-bind（一切可读），
 * workspace-write 追加 tmpfs /tmp 与工作区 rw bind（原路径，路径透明）。
 */
export function bwrapProfileArgs(policy: RunnerPolicy): string[] {
	const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent"];
	if (policy.mode === "workspace-write") {
		args.push("--tmpfs", "/tmp");
		args.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
	}
	return args;
}

/** Landlock 允许清单：readOnly / + readWrite /dev/null（workspace-write 追加 /tmp 与工作区）。 */
export function landlockProfileArgs(policy: RunnerPolicy): string[] {
	const readWrite = ["/dev/null"];
	if (policy.mode === "workspace-write") {
		readWrite.push("/tmp", policy.workspaceRoot);
	}
	return grantArgs({ readOnly: ["/"], readWrite });
}

/** 把一个路径引用为 SBPL 字符串字面量（转义 \ 与 "）。 */
function sbplString(path: string): string {
	return `"${path.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

/**
 * Seatbelt SBPL：默认允许、拒绝一切文件写，放行 /dev/null 与 writableRoots
 * （与 fs 围栏共用 policy.writableRoots 推导，防止语义漂移）。
 */
export function seatbeltProfileArgs(policy: RunnerPolicy): string[] {
	const forms = [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write* (literal ${sbplString("/dev/null")}))`,
	];
	const roots = writableRoots(policy.mode, policy.workspaceRoot);
	if (roots.length > 0) {
		forms.push(`(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`);
	}
	return ["-p", forms.join(" ")];
}

const PLATFORM_CHAINS: Record<string, readonly RunnerKind[]> = {
	linux: ["bwrap", "landlock"],
	darwin: ["seatbelt"],
};

const STATIC_ENFORCEMENT: Record<RunnerKind, SandboxEnforcement> = {
	bwrap: "full",
	landlock: "full",
	seatbelt: "full",
};

let cachedVerdict: SelectedRunner | undefined;

/** 清探测缓存（测试用；生产进程内探测只做一次）。 */
export function resetRunnerCache(): void {
	cachedVerdict = undefined;
}

export function defaultProbeBwrap(timeoutMs: number): boolean {
	const probe = spawnSync("bwrap", [...bwrapProfileArgs({ mode: "read-only", workspaceRoot: "/" }), "--", "true"], {
		timeout: timeoutMs,
		stdio: "ignore",
	});
	return probe.status === 0;
}

/**
 * 平台链选择（spec §3）：单候选直接选定（seatbelt 执行期拒绝即 fail-closed）；
 * 多候选按序功能探测；全不可用 → unavailable（调用方必须抛错，绝不裸跑）。
 */
export function selectRunner(probeTimeoutMs: number, hooks: RunnerHooks = {}): SelectedRunner {
	cachedVerdict ??= chainVerdict(probeTimeoutMs, hooks);
	return cachedVerdict;
}

function chainVerdict(probeTimeoutMs: number, hooks: RunnerHooks): SelectedRunner {
	const chain = PLATFORM_CHAINS[hooks.platform ?? process.platform] ?? [];
	const [first, ...rest] = chain;
	if (first === undefined) return { runner: "unavailable" };
	if (rest.length === 0) return { runner: first, enforcement: STATIC_ENFORCEMENT[first] };
	for (const kind of chain) {
		const enforcement = probeRunner(kind, probeTimeoutMs, hooks);
		if (enforcement !== "unusable") return { runner: kind, enforcement };
	}
	return { runner: "unavailable" };
}

function probeRunner(kind: RunnerKind, probeTimeoutMs: number, hooks: RunnerHooks): SandboxEnforcement | "unusable" {
	switch (kind) {
		case "bwrap":
			return (hooks.probeBwrap ?? defaultProbeBwrap)(probeTimeoutMs) ? "full" : "unusable";
		case "landlock": {
			const launcher = (hooks.launcherPath ?? launcherPath)();
			const probe = hooks.probeLandlock ?? ((l: string, t: number) => probeLandlockLauncher(l, { timeoutMs: t }));
			return probe(launcher, probeTimeoutMs);
		}
		case "seatbelt":
			return "full"; // 单候选链不会走到探测；保留分支的完备性
	}
}

/** 选中 runner 对一份策略的完整调用前缀（'--' 与命令 argv 由 confine 拼接）。 */
export function runnerInvocation(
	selected: SelectedRunner & { runner: RunnerKind },
	policy: RunnerPolicy,
	hooks: RunnerHooks = {},
): string[] {
	switch (selected.runner) {
		case "bwrap":
			return ["bwrap", ...bwrapProfileArgs(policy)];
		case "landlock":
			return [(hooks.launcherPath ?? launcherPath)(), ...landlockProfileArgs(policy)];
		case "seatbelt":
			return [hooks.seatbeltExec ?? "sandbox-exec", ...seatbeltProfileArgs(policy)];
	}
}
