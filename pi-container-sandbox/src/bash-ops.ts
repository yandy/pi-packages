import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
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

export interface SandboxBashOpts extends ConfineOptions {
	mode: SandboxMode;
	workspaceRoot: string;
	/** 测试注入点；生产用 node:child_process spawn。 */
	spawnFn?: SpawnFn;
}

/** stderr 分类窗口：只保留尾部 8KB（拒绝/失败信息总在末尾附近）。 */
const STDERR_TAIL_BYTES = 8192;

/**
 * 受限 bash 的 BashOperations（spec §2）：confine 后本地 spawn，路径透明
 * （cwd 用宿主路径原样）。timeout 单位为秒（pi 约定）。
 */
export function createSandboxBashOps(opts: SandboxBashOpts): BashOperations {
	return {
		exec: (command, cwd, execOpts) =>
			new Promise<{ exitCode: number | null }>((resolve, reject) => {
				if (execOpts.signal?.aborted) {
					// 已中止的信号：不 spawn，按取消语义 resolve（abort→SIGTERM→null 一致）
					resolve({ exitCode: null });
					return;
				}
				const rawArgv = ["bash", "-c", command];
				// Review Focus #3：只钉消息翻译（LC_MESSAGES），不动 LANG/LC_CTYPE/LC_ALL
				const env: NodeJS.ProcessEnv = { ...process.env, ...execOpts.env, LC_MESSAGES: "C" };

				let argv: readonly string[];
				let confined: ConfinedArgv | undefined;
				try {
					if (opts.mode === "danger-full-access") {
						argv = rawArgv;
					} else {
						confined = confine(rawArgv, opts.mode as ConfinedSandboxMode, opts.workspaceRoot, opts);
						argv = confined.argv;
					}
				} catch (err) {
					reject(err); // SandboxUnavailableError：fail-closed，未 spawn
					return;
				}

				const spawnFn = opts.spawnFn ?? (spawn as unknown as SpawnFn);
				const child = spawnFn(argv[0], argv.slice(1), {
					cwd,
					env,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let stderrTail = "";
				child.stdout?.on("data", (chunk: Buffer) => execOpts.onData(chunk));
				child.stderr?.on("data", (chunk: Buffer) => {
					execOpts.onData(chunk);
					stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-STDERR_TAIL_BYTES);
				});

				let timer: NodeJS.Timeout | undefined;
				if (execOpts.timeout !== undefined) {
					timer = setTimeout(() => child.kill("SIGKILL"), execOpts.timeout * 1000);
				}
				const onAbort = () => child.kill("SIGTERM");
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
							execOpts.onData(Buffer.from(`\n${sandboxDenialMarker(opts.mode)}\n${escalationHintMarker("command")}\n`));
						}
					}
					resolve({ exitCode: code });
				});
			}),
	};
}
