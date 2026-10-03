/**
 * The Windows ACL confinement runner: the standalone entry the pi-sandbox
 * seam spawns in place of the caller's command. It derives the capability
 * SIDs, replays the idempotent grants, builds the WRITE_RESTRICTED token,
 * spawns the wrapped argv under it inside a kill-on-close Job with the
 * caller's stdio inherited, and mirrors the child's exit code.
 *
 * Stable argv contract (Task 9 builds it):
 *   [node, runner.js, '--workspace', <dir>, '--temp', <dir>,
 *    '--mode', <read-only|workspace-write>, '--', <argv...>]
 *
 * Deltas from the deepseek-harness reference (`sandbox-windows-acl/src/runner.ts`)
 * by design:
 *  - No `AclSandbox` indirection: `main` orchestrates the Task 4/5/6 functions
 *    directly. The runner derives its own capability SIDs (no `--write-sid` /
 *    `--temp-write-sid` seam flags), and both grants are STANDING — there is no
 *    `dispose()`, no `revokeWrite`, and no owned temp directory to remove.
 *  - TMP/TEMP are never rewritten (`lpEnvironment` stays NULL in `proc.js`):
 *    the granted `--temp` root IS the host temp root.
 *  - `fail` here only throws `RunnerFailure`; the entry branch prints exactly
 *    one `windows-acl-run: <detail>` line and owns the 127 exit.
 *
 * Ordering that is load-bearing:
 *  - `assertGrantRootsDisjoint` runs before any Win32 call (workspace-write).
 *  - `SetConsoleCtrlHandler(null, 1)` is installed before the spawn so the
 *    runner survives Ctrl+C long enough to mirror the child's exit status.
 *  - Both SIDs derive through `canonicalSidInput` so two spellings of one
 *    directory cannot mint two capability identities.
 *  - The token default-DACL patch names temp → workspace → Everyone, so
 *    objects created inside the temp tree never acquire the shared workspace
 *    capability.
 *  - `read-only` grants nothing: no `grantWrite`, no capability SID enters the
 *    restricting list, and no SID string is parsed. The default-DACL patch
 *    still runs (with Everyone) — see §4.6 of the design — otherwise the
 *    confined process could not create anonymous stdio pipes.
 *
 * Plain ESM JavaScript on purpose: the runner entry executes in a standalone
 * node process and Node refuses TypeScript type-stripping inside node_modules,
 * where the published extension lives. Relative imports here must keep the
 * `.js` extension.
 * @module
 */

import { pathToFileURL } from "node:url";

import * as abi from "./abi.js";
import { grantWrite } from "./acl.js";
import { parseArgs, requireDirectory, RUNNER_FAILURE_EXIT, RUNNER_SIGNATURE, RunnerFailure } from "./cli.js";
import { allocPtrSlot, decodePtr, throwLastError, win32 } from "./ffi.js";
import { spawnInheritedJobProcess, waitForProcessExit } from "./proc.js";
import { assertGrantRootsDisjoint, canonicalSidInput, tempWriteSid, workspaceWriteSid } from "./sid.js";
import {
	createRestrictedToken,
	findLogonSid,
	makeWellKnownSid,
	openCurrentProcessToken,
	restrictTokenIntegrity,
	setTokenDefaultDaclGrant,
} from "./token.js";

/**
 * Unwind with a `RunnerFailure`, the failure vocabulary the entry branch
 * classifies on. The caller owns reporting.
 * @param {string} detail - `windows-acl-run: <detail>` payload.
 * @returns {never}
 */
function fail(detail) {
	throw new RunnerFailure(detail);
}

/**
 * Parse an SDDL SID string into a native SID pointer allocated by
 * ConvertStringSidToSidW. The allocation is process-lifetime on purpose: the
 * runner never revokes and exits with the child, so there is nothing to free.
 * @param {object} api - the binding table.
 * @param {string} sidString - the `S-1-4-…` capability SID.
 * @returns {bigint} the parsed SID pointer (never null).
 */
function parseSid(api, sidString) {
	const sidSlot = allocPtrSlot();
	if (api.convertStringSidToSidW(sidString, sidSlot) === 0) throwLastError(api, "ConvertStringSidToSidW", sidString);
	const sid = decodePtr(sidSlot);
	if (sid === null) throwLastError(api, "ConvertStringSidToSidW", sidString);
	return sid;
}

/**
 * Run one confined command end to end and return its exit code. Injectable
 * for tests: `deps.api` replaces the Win32 binding table, `deps.spawn(token,
 * options)` replaces the spawner, and `deps.wait(process)` replaces the wait.
 * Production defaults resolve `win32()`, `spawnInheritedJobProcess`, and
 * `waitForProcessExit` inside `main`, so importing this module stays
 * side-effect-free apart from the entry branch.
 * @param {string[]} rawArgs - argv without the `node` + script prefix.
 * @param {object} [deps] - test seams.
 * @returns {Promise<number>} the confined child's exit code.
 */
export async function main(rawArgs, deps = {}) {
	const parsed = parseArgs(rawArgs);
	// Both directories are validated in both modes: a provider bug that passes
	// a bogus root must fail loudly at the runner boundary, never mid-child.
	requireDirectory("--workspace", parsed.workspace);
	requireDirectory("--temp", parsed.temp);
	if (parsed.mode === "workspace-write") assertGrantRootsDisjoint(parsed.workspace, parsed.temp);

	const api = deps.api ?? (await win32());
	const spawn = deps.spawn ?? ((token, options) => spawnInheritedJobProcess(api, { ...options, token }));
	const wait = deps.wait ?? ((childProcess) => waitForProcessExit(api, childProcess));

	// Ignore this process's own CTRL+C: the confined child (same console) keeps
	// handling its own; the runner must survive to mirror the child's exit code.
	if (api.setConsoleCtrlHandler(null, 1) === 0) {
		fail(`SetConsoleCtrlHandler failed (Win32 ${api.getLastError()})`);
	}

	const workspaceRoot = canonicalSidInput(parsed.workspace);
	const tempRoot = canonicalSidInput(parsed.temp);
	const workspaceSid = parsed.mode === "workspace-write" ? workspaceWriteSid(workspaceRoot) : undefined;
	const tempSid = parsed.mode === "workspace-write" ? tempWriteSid(tempRoot) : undefined;

	const currentToken = openCurrentProcessToken(api);
	const lowLabelSid = makeWellKnownSid(api, abi.WinLowLabelSid);
	const worldSid = makeWellKnownSid(api, abi.WinWorldSid);
	const writeSids = [];
	if (workspaceSid !== undefined && tempSid !== undefined) {
		const workspaceSidPtr = parseSid(api, workspaceSid);
		const tempSidPtr = parseSid(api, tempSid);
		grantWrite(api, parsed.workspace, workspaceSidPtr, lowLabelSid, worldSid);
		grantWrite(api, parsed.temp, tempSidPtr, lowLabelSid, worldSid);
		writeSids.push(workspaceSidPtr, tempSidPtr);
	}
	const logonSid = findLogonSid(api, currentToken);
	const token = createRestrictedToken(api, currentToken, logonSid, writeSids, { world: worldSid }, parsed.mode);
	restrictTokenIntegrity(api, token, lowLabelSid);
	// temp → workspace → Everyone: new objects created inside the temp tree must
	// not acquire the shared workspace capability.
	setTokenDefaultDaclGrant(api, token, writeSids[1] ?? writeSids[0] ?? worldSid);
	const child = spawn(token, { command: parsed.command, args: parsed.args, cwd: parsed.workspace });
	return wait(child.process);
}

/**
 * Whether this module is the process entry point (`node runner.js …`) and not
 * an import from a test or another module.
 * @returns {boolean} true when `process.argv[1]` is this file.
 */
function isEntryPoint() {
	const entry = process.argv[1];
	return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			process.stderr.write(`${RUNNER_SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = RUNNER_FAILURE_EXIT;
		},
	);
}
