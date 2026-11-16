import { getPowerShellConfig, type PowerShellOperations } from "@earendil-works/pi-coding-agent";
import { createSandboxShellOps, type ShellOpsOptions } from "./shell-ops";

/** 与 pi 本地 powershell ops 一致：让 pwsh 以 UTF-8 输出（否则中文结果乱码）。 */
export const POWERSHELL_UTF8_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

export interface SandboxPowerShellOpts extends Omit<ShellOpsOptions, "shell"> {
	/** 测试注入：宿主解析结果（生产用 getPowerShellConfig）。 */
	powerShellConfig?: () => { shell: string; args: string[] };
}

/**
 * pwsh 的受限 ops：argv 来自宿主的 getPowerShellConfig，命令串前置 UTF-8 前缀，
 * 其余（guard/confine/spawn/timeout/abort/拒绝记账）复用 shell-ops 工厂。
 * 配置解析失败（如工具不可用）在 Promise 执行器内抛错 → reject 且不 spawn（fail-closed）。
 */
export function createSandboxPowerShellOps(opts: SandboxPowerShellOpts): PowerShellOperations {
	const resolve = opts.powerShellConfig ?? getPowerShellConfig;
	return createSandboxShellOps({
		...opts,
		cwdErrorMessage: opts.cwdErrorMessage ?? "Cannot execute PowerShell commands.",
		shell: (command) => {
			const { shell, args } = resolve();
			return [shell, ...args, `${POWERSHELL_UTF8_PREFIX}${command}`];
		},
	});
}
