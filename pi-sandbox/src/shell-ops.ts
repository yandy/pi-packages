import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { access as fsAccess, constants } from "node:fs/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
	classifyDenial,
	classifyRunnerFailure,
	confine,
	SandboxUnavailableError,
	type ConfinedArgv,
	type ConfineOptions,
} from "./confine";
import { escalationHintMarker, sandboxDenialMarker } from "./escalation";
import type { ConfinedSandboxMode, SandboxMode } from "./policy";

export type SpawnFn = (program: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** I3：杀整个进程组（detached spawn → 子进程是组长）；失败（无 pid/组不存在）回退杀直接子进程。 */
function killTree(child: ChildProcess, signal: NodeJS.Signals, platform: string): void {
	// win32 没有进程组：杀 runner 即关闭 Job，受限子孙随之灭亡（spec §4.7）
	if (platform !== "win32" && child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {}
	}
	child.kill(signal);
}

export interface ShellOpsOptions extends ConfineOptions {
	mode: SandboxMode;
	workspaceRoot: string;
	/** 把原始命令翻译成 shell 的 argv（bash: `["bash","-c",command]`；pwsh 见 powershell-ops）。 */
	shell: (command: string) => readonly string[];
	/** 宿平台注入点（默认 process.platform）：决定 kill 策略与 spawn 选项（detached）。 */
	platform?: string;
	/** 测试注入点；生产用 node:child_process spawn。 */
	spawnFn?: SpawnFn;
	/** 沙箱拒绝（classifyDenial 命中）时的记账回调：denial-first 门禁据此放行一次提权重试。 */
	onDenial?: () => void;
	/**
	 * 受限模式（非 danger-full-access）的前置守卫（同步）：抛错即 reject 且不 spawn。
	 * 在 danger-full-access 早退之后、confine 之前调用；该模式不经过 guard。
	 */
	guard?: (mode: SandboxMode) => void;
}

/** stderr 分类窗口：只保留尾部 8KB（拒绝/失败信息总在末尾附近）。 */
const STDERR_TAIL_BYTES = 8192;

/**
 * 受限 shell 的公共执行路径（spec §2）：shell 翻译 argv → guard（受限模式）→ confine →
 * 本地 spawn，路径透明（cwd 用宿主路径原样）；流式输出并分类 runner failure / denial，
 * 守住 timeout/abort 契约。timeout 单位为秒（pi 约定）。bash 与 pwsh 共用本工厂。
 */
export function createSandboxShellOps(opts: ShellOpsOptions): BashOperations {
	return {
		exec: async (command, cwd, execOpts) => {
			// M4：cwd 存在性预检，逐字镜像 pi 本地 ops（dist/core/tools/bash.js:29-34）的友好报错，
			// 且与其同序放在 abort 早退之前；三档模式一致（否则模型只见到裸 spawn ENOENT）。
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}
			return new Promise<{ exitCode: number | null }>((resolve, reject) => {
				if (execOpts.signal?.aborted) {
					// Ruling 9 + I1：已中止的信号——不 spawn，按 pi 本地 ops 契约 reject "aborted"
					reject(new Error("aborted"));
					return;
				}
				const platform = opts.platform ?? process.platform;
				const rawArgv = opts.shell(command);
				// Review Focus #3 + Ruling 10：钉消息翻译（LC_MESSAGES）；移除 LC_ALL（POSIX 中它覆盖 LC_MESSAGES，
				// 保留会使中文环境下 denial 签名全 miss）；不动 LANG/LC_CTYPE（编码/排序行为不变）
				const env: NodeJS.ProcessEnv = { ...process.env, ...execOpts.env, LC_MESSAGES: "C" };
				delete env.LC_ALL;

				let argv: readonly string[];
				let confined: ConfinedArgv | undefined;
				try {
					if (opts.mode === "danger-full-access") {
						argv = rawArgv;
					} else {
						// win32 bash 拒绝（Ruling 2）等前置守卫：必须在 danger-full-access 早退之后，
						// 抛错即 fail-closed（不 spawn）。
						opts.guard?.(opts.mode);
						confined = confine(rawArgv, opts.mode as ConfinedSandboxMode, opts.workspaceRoot, opts);
						argv = confined.argv;
					}
				} catch (err) {
					reject(err); // SandboxUnavailableError / UnsupportedWindowsShellError：fail-closed，未 spawn
					return;
				}

				const spawnFn = opts.spawnFn ?? (spawn as unknown as SpawnFn);
				const child = spawnFn(argv[0], argv.slice(1), {
					cwd,
					env,
					stdio: ["ignore", "pipe", "pipe"],
					detached: platform !== "win32", // I3：独立进程组，使 killTree 能连带孙进程一起杀；win32 无进程组
					windowsHide: true, // win32：不弹控制台窗口
				});

				let stderrTail = "";
				child.stdout?.on("data", (chunk: Buffer) => execOpts.onData(chunk));
				child.stderr?.on("data", (chunk: Buffer) => {
					execOpts.onData(chunk);
					stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-STDERR_TAIL_BYTES);
				});

				let timer: NodeJS.Timeout | undefined;
				let timedOut = false;
				// Ruling 20：对齐 pi 本地 ops 的 `timeout > 0` 守卫（dist/core/tools/bash.js:60）——
				// timeout 为 0/负数表示无超时，不武装定时器，也不得 reject "timeout:0"。
				if (execOpts.timeout !== undefined && execOpts.timeout > 0) {
					timer = setTimeout(() => {
						timedOut = true;
						killTree(child, "SIGKILL", platform);
					}, execOpts.timeout * 1000);
				}
				const onAbort = () => killTree(child, "SIGTERM", platform);
				execOpts.signal?.addEventListener("abort", onAbort, { once: true });

				const cleanup = () => {
					if (timer) clearTimeout(timer);
					execOpts.signal?.removeEventListener("abort", onAbort);
				};

				child.on("error", (err) => {
					cleanup();
					reject(err);
				});
				child.on("close", (code) => {
					cleanup();
					if (confined && typeof code === "number" && code !== 0) {
						const fatal = classifyRunnerFailure(code, stderrTail, confined.runnerFailureRules);
						if (fatal !== undefined) {
							reject(new SandboxUnavailableError(opts.mode as ConfinedSandboxMode, fatal));
							return;
						}
						if (classifyDenial(code, stderrTail, confined.denialSignatures)) {
							opts.onDenial?.();
							execOpts.onData(Buffer.from(`\n${sandboxDenialMarker(opts.mode)}\n${escalationHintMarker("command")}\n`));
						}
					}
					// I1：对齐 pi 本地 ops 契约（dist bash.js：throw Error("aborted") / throw Error(`timeout:${timeout}`)）——
					// 否则 pi 把 null 当成功分支，超时/中止命令以“正常完成+截断输出”返回模型。
					if (code === null) {
						if (timedOut) {
							reject(new Error(`timeout:${execOpts.timeout}`));
							return;
						}
						if (execOpts.signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
					}
					resolve({ exitCode: code }); // 外部杀（无 timer 无 abort）：保留 null 语义
				});
			});
		},
	};
}
