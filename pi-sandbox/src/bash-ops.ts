import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { assertShellAllowed } from "./confine";
import { createSandboxShellOps, type ShellOpsOptions } from "./shell-ops";

/**
 * bash 的受限 ops：公共执行路径见 shell-ops（行为与 1.3.x 一致）。
 * win32 受限模式只支持 pwsh（Ruling 2），guard 在任何 spawn 前拒绝 bash。
 */
export function createSandboxBashOps(opts: SandboxBashOpts): BashOperations {
	return createSandboxShellOps({
		...opts,
		shell: (command) => ["bash", "-c", command],
		guard: (mode) => assertShellAllowed("bash", opts.platform ?? process.platform, mode),
	});
}

/** bash ops 的构造参数：shell 翻译与 win32 守卫由本模块钉死。 */
export type SandboxBashOpts = Omit<ShellOpsOptions, "shell" | "guard">;

export type { SpawnFn } from "./shell-ops";
