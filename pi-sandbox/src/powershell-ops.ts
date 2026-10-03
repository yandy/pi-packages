import type { BashOperations } from "@earendil-works/pi-coding-agent";
import * as piHost from "@earendil-works/pi-coding-agent";
import { createSandboxShellOps, type ShellOpsOptions } from "./shell-ops";

/** 与 pi 本地 powershell ops 一致：让 pwsh 以 UTF-8 输出（否则中文结果乱码）。 */
export const POWERSHELL_UTF8_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/**
 * 宿主探测（命名空间导入 + `typeof === "function"`）：pi < 1.0.0 没有 `getPowerShellConfig`，
 * 静态具名导入会在链接期失败（ESM），命名空间属性读取最坏只是 undefined。
 * 探测本身在模块加载时做一次；解析（调用该函数）在每次 exec 做，宿主配置可变。
 */
const host = piHost as unknown as Record<string, unknown>;
const hostGetPowerShellConfig = typeof host.getPowerShellConfig === "function"
	? (host.getPowerShellConfig as () => { shell: string; args: string[] })
	: undefined;

export interface SandboxPowerShellOpts extends Omit<ShellOpsOptions, "shell"> {
	/** 测试注入：宿主解析结果（生产用 getPowerShellConfig）。 */
	powerShellConfig?: () => { shell: string; args: string[] };
}

/**
 * pwsh 的受限 ops：argv 来自宿主的 getPowerShellConfig，命令串前置 UTF-8 前缀，
 * 其余（guard/confine/spawn/timeout/abort/拒绝记账）复用 shell-ops 工厂。
 * 解析失败（宿主无该导出 / 工具不可用）在 Promise 执行器内抛错 → reject 且不 spawn（fail-closed）。
 *
 * 返回 `BashOperations`：本地宿主的类型是 0.80.2，还没有 `PowerShellOperations`；
 * pi ≥ 1.0.0 的结构同形（exec 形状一致），调用方按需窄化。
 */
export function createSandboxPowerShellOps(opts: SandboxPowerShellOpts): BashOperations {
	const resolve = opts.powerShellConfig ?? hostGetPowerShellConfig
		?? (() => {
			throw new Error("pi-sandbox: the powershell tool requires pi >= 1.0.0 (getPowerShellConfig is unavailable)");
		});
	return createSandboxShellOps({
		...opts,
		cwdErrorMessage: opts.cwdErrorMessage ?? "Cannot execute PowerShell commands.",
		shell: (command) => {
			const { shell, args } = resolve();
			return [shell, ...args, `${POWERSHELL_UTF8_PREFIX}${command}`];
		},
	});
}
