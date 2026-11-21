/// <reference types="node" />

import { type ChildProcess, spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const REPOSITORY_ENVIRONMENT_VARIABLES = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_QUARANTINE_PATH",
] as const;

export interface GitRunOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	allowNonZeroExit?: boolean;
	maxOutputBytes?: number;
	/** Written verbatim to the child's stdin, which is closed afterwards. */
	stdin?: string;
}

export interface GitResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed: boolean;
	truncated: boolean;
}

export type RunGit = (args: string[], options: GitRunOptions) => Promise<GitResult>;

export class GitCommandError extends Error {
	readonly result: GitResult;

	constructor(args: string[], result: GitResult) {
		const detail = result.stderr.trim().slice(0, 2_000);
		super(`git ${args.join(" ")} failed (exit ${result.code ?? "unknown"})${detail ? `: ${detail}` : ""}`);
		this.name = "GitCommandError";
		this.result = result;
	}
}

export class GitUnavailableError extends Error {
	constructor() {
		super("Git executable was not found");
		this.name = "GitUnavailableError";
	}
}

function cleanInheritedGitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const name of REPOSITORY_ENVIRONMENT_VARIABLES) delete env[name];
	return env;
}

export function createGitRunner(spawnFn: typeof spawn = spawn): RunGit {
	return (args, options) => {
		const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		const env = { ...cleanInheritedGitEnvironment(process.env), ...options.env };

		return new Promise<GitResult>((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = spawnFn("git", args, {
					cwd: options.cwd,
					env,
					shell: false,
					stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
					windowsHide: true,
				});
			} catch (error) {
				if (isErrno(error, "ENOENT")) reject(new GitUnavailableError());
				else reject(error);
				return;
			}

			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let outputBytes = 0;
			let killed = false;
			let truncated = false;
			let settled = false;

			const removeAbortListener = () => {
				options.signal?.removeEventListener("abort", onAbort);
			};
			const makeResult = (code: number | null): GitResult => ({
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				code,
				killed,
				truncated,
			});
			const finish = (code: number | null) => {
				if (settled) return;
				settled = true;
				removeAbortListener();
				const result = makeResult(code);
				if (!options.allowNonZeroExit && code !== 0) reject(new GitCommandError(args, result));
				else resolve(result);
			};
			const terminate = () => {
				killed = true;
				child.kill();
			};
			const onAbort = () => terminate();
			const append = (target: Buffer[], chunk: Buffer | string) => {
				if (truncated) return;
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				const remaining = Math.max(0, maxOutputBytes - outputBytes);
				const accepted = buffer.subarray(0, remaining);
				if (accepted.length > 0) target.push(accepted);
				outputBytes += accepted.length;
				if (accepted.length < buffer.length || outputBytes >= maxOutputBytes) {
					truncated = true;
					terminate();
				}
			};

			child.stdout?.on("data", (chunk: Buffer | string) => append(stdout, chunk));
			child.stderr?.on("data", (chunk: Buffer | string) => append(stderr, chunk));
			child.once("error", (error) => {
				if (settled) return;
				if (isErrno(error, "ENOENT")) {
					settled = true;
					removeAbortListener();
					reject(new GitUnavailableError());
					return;
				}
				if (options.signal?.aborted && isAbortError(error)) {
					killed = true;
					finish(null);
					return;
				}
				settled = true;
				removeAbortListener();
				reject(error);
			});
			child.once("close", (code) => finish(code));

			if (options.stdin !== undefined) {
				child.stdin?.on("error", (error) => {
					// A partially delivered payload must not look like success: fail closed unless the
					// caller already aborted or the child is being torn down for truncation/abort.
					if (settled || killed || options.signal?.aborted) return;
					settled = true;
					removeAbortListener();
					reject(error);
				});
				child.stdin?.end(options.stdin);
			}

			if (options.signal?.aborted) onAbort();
			else options.signal?.addEventListener("abort", onAbort, { once: true });
		});
	};
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
