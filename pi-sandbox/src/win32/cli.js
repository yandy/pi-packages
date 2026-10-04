/**
 * The windows-acl confinement runner's argv surface and failure vocabulary.
 *
 * Plain ESM JavaScript on purpose: the runner entry executes in a standalone
 * node process loaded from node_modules, where Node refuses TypeScript
 * type-stripping. Relative imports here must keep the `.js` extension.
 *
 * Stable argv contract (the TS seam builds it):
 *   [node, cli.js, '--workspace', <dir>, '--temp', <dir>,
 *    '--mode', <read-only|workspace-write>, '--', <argv...>]
 *
 * Deltas from the deepseek-harness reference (`runner.ts`): the `--write-sid`
 * and `--temp-write-sid` seam-managed-SID flags are gone — this package's
 * runner derives its own capability SIDs, so both flags are rejected as
 * `unknown argument: <flag>`. `fail()` only throws; the stderr signature
 * line (`windows-acl-run: <detail>`) is printed exactly once by the Task 8
 * entry point, which also owns the process exit.
 *
 * Ported from deepseek-harness (MIT)
 * `packages/sandbox/sandbox-windows-acl/src/runner.ts`.
 * @module
 */

import { existsSync, statSync } from "node:fs";

export const RUNNER_SIGNATURE = "windows-acl-run";
export const RUNNER_FAILURE_EXIT = 127;

/**
 * A runner-side failure: bad argv, a missing root directory, or any later
 * token/spawn failure the entry point classifies on.
 */
export class RunnerFailure extends Error {}

/**
 * Unwind with a `RunnerFailure`; the caller owns reporting.
 * @param {string} detail - `windows-acl-run: <detail>` payload.
 * @returns {never}
 */
function fail(detail) {
	throw new RunnerFailure(detail);
}

/**
 * Parse the runner argv (without the `node` + script prefix). Parsing stops
 * at the first `--`; every token after it is the wrapped command's argv and
 * is kept verbatim.
 * @param {string[]} raw - `process.argv.slice(2)`.
 * @returns {{ workspace: string, temp: string, mode: string, command: string, args: string[] }}
 */
export function parseArgs(raw) {
	let workspace;
	let temp;
	let mode;
	let index = 0;
	for (; index < raw.length; index++) {
		const token = raw[index];
		if (token === "--") {
			index++;
			break;
		}
		index++;
		const value = raw[index];
		if (value === undefined) fail(`missing value after ${token}`);
		switch (token) {
			case "--workspace":
				workspace = value;
				break;
			case "--temp":
				temp = value;
				break;
			case "--mode":
				mode = value;
				break;
			default:
				fail(`unknown argument: ${token}`);
		}
	}
	if (workspace === undefined) fail("missing --workspace");
	if (temp === undefined) fail("missing --temp");
	if (mode !== "read-only" && mode !== "workspace-write") fail(`unknown mode: ${String(mode)}`);
	const argv = raw.slice(index);
	const command = argv[0];
	if (command === undefined) fail("missing command after --");
	return { workspace, temp, mode, command, args: argv.slice(1) };
}

/**
 * Fail unless `path` exists and is a directory. Both roots are validated in
 * both modes: a provider bug that passes a bogus root must fail loudly at the
 * runner boundary, never mid-child.
 * @param {string} label - `--workspace` or `--temp`, for the message.
 * @param {string} path - directory that must already exist.
 * @returns {void}
 */
export function requireDirectory(label, path) {
	if (!existsSync(path) || !statSync(path).isDirectory()) {
		fail(`${label} is not an existing directory: ${path}`);
	}
}
