/**
 * Restricted-process primitives for the Windows ACL sandbox: Win32 command-line
 * quoting, the kill-on-close Job Object, and the suspended → assign-to-Job →
 * resume spawn lifecycle.
 *
 * The child is created suspended so target code cannot run before the Job
 * assignment applies, and the Job carries JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so
 * cancelling the runner (the only holder of the Job handle) tears down the
 * whole process tree.
 *
 * Plain ESM JavaScript on purpose: the runner entry executes in a standalone
 * node process and Node refuses TypeScript type-stripping inside node_modules,
 * where the published extension lives. Relative imports here must keep the
 * `.js` extension.
 *
 * Ported from deepseek-harness (MIT)
 * `packages/subprocess/win32-process/src/process.ts` (subset): `quoteArg`,
 * `buildCommandLine`, `createKillOnCloseJob`, `inheritedStandardHandles`,
 * `spawnJobProcess`, `spawnInheritedJobProcess`, `waitForProcessExit`, the
 * STARTUPINFOW/PROCESS_INFORMATION record helpers, and `closeBestEffort`.
 * Deliberately not ported: the piped-stdio primitives, the fd-7 control pipe,
 * the ordinary current-token runner, and the typed environment block — this
 * package passes `lpEnvironment = NULL` and inherits the runner environment
 * unchanged (it never rewrites TMP/TEMP).
 * @module
 */

import * as abi from "./abi.js";
import {
	allocUint32,
	decodeUint32At,
	isNullPtr,
	processInformationType,
	requireKoffi,
	startupInfoType,
	throwLastError,
	throwWin32,
} from "./ffi.js";

/**
 * Release a native record allocated by this module once it was allocated.
 * @param {bigint|undefined} pointer - pointer allocated by this module, or
 *   undefined before allocation.
 */
function freeNative(pointer) {
	if (pointer !== undefined) requireKoffi().free(pointer);
}

/**
 * Allocate a zeroed STARTUPINFOW. The record type comes from `ffi.js`, whose
 * `ffiTypes()` asserts `.size === abi.STARTUPINFOW_SIZE` on first use.
 * @returns {bigint} allocated struct pointer.
 */
function allocStartupInfo() {
	return requireKoffi().alloc(startupInfoType(), 1);
}

/**
 * Encode the stdio-bearing STARTUPINFOW fields.
 * @param {bigint} startupInfo - allocated STARTUPINFOW pointer.
 * @param {object} fields - fields required for inherited stdio.
 */
function encodeStartupInfo(startupInfo, fields) {
	requireKoffi().encode(startupInfo, startupInfoType(), fields);
}

/**
 * Allocate a zeroed PROCESS_INFORMATION. The record type comes from `ffi.js`,
 * whose `ffiTypes()` asserts `.size === abi.PROCESS_INFORMATION_SIZE` on first
 * use.
 * @returns {bigint} allocated struct pointer.
 */
function allocProcessInfo() {
	return requireKoffi().alloc(processInformationType(), 1);
}

/**
 * Decode PROCESS_INFORMATION.
 * @param {bigint} processInfo - struct pointer filled by CreateProcessAsUserW.
 * @returns {object} process/thread handles and ids.
 */
function decodeProcessInfo(processInfo) {
	return requireKoffi().decode(processInfo, processInformationType());
}

/**
 * Close a handle when one was produced, ignoring close failures. Cleanup must
 * not mask the spawn outcome the caller is about to report.
 * @param {object} api - active binding table.
 * @param {bigint|null|undefined} handle - handle to close.
 */
function closeBestEffort(api, handle) {
	if (!isNullPtr(handle)) api.closeHandle(handle);
}

/**
 * Quote one argument according to CommandLineToArgvW parsing.
 * @param {string} argument - one argv entry.
 * @returns {string} bare or quoted command-line segment.
 */
export function quoteArg(argument) {
	if (argument === "") return '""';
	// Quote an argument that ends in a backslash even without whitespace or a
	// quote, so the final backslash is doubled against the closing quote. The
	// reference returns such arguments bare; quoting is parse-safe and cannot
	// change the parsed argv.
	if (!/[\s"]/u.test(argument) && !argument.endsWith("\\")) return argument;
	let quoted = '"';
	for (let index = 0; index < argument.length; index += 1) {
		let backslashes = 0;
		while (index < argument.length && argument.charAt(index) === "\\") {
			backslashes += 1;
			index += 1;
		}
		if (index === argument.length) {
			quoted += "\\".repeat(backslashes * 2);
		} else if (argument.charAt(index) === '"') {
			quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
		} else {
			quoted += "\\".repeat(backslashes) + argument.charAt(index);
		}
	}
	return `${quoted}"`;
}

/**
 * Build the mutable command line accepted by CreateProcessAsUserW.
 * @param {string} program - executable argv entry.
 * @param {readonly string[]} args - remaining argv entries.
 * @returns {string} joined Win32 command line.
 */
export function buildCommandLine(program, args) {
	return [program, ...args].map(quoteArg).join(" ");
}

/**
 * Create an unnamed Job Object that kills every member when its final handle
 * closes.
 * @param {object} api - active binding table.
 * @returns {bigint} caller-owned Job handle.
 * @remarks JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is written into
 *   BASIC_LIMIT_INFORMATION.LimitFlags at `JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET`
 *   inside the zeroed JOBOBJECT_EXTENDED_LIMIT_INFORMATION record.
 */
function createKillOnCloseJob(api) {
	const job = api.createJobObjectW(null, null);
	if (isNullPtr(job)) throwLastError(api, "CreateJobObjectW");
	const information = Buffer.alloc(abi.JOBOBJECT_EXTENDED_LIMIT_SIZE);
	information.writeUInt32LE(
		abi.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		abi.JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET,
	);
	if (
		api.setInformationJobObject(job, abi.JobObjectExtendedLimitInformation, information, information.length) === 0
	) {
		const win32Code = api.getLastError();
		api.closeHandle(job);
		throwWin32(api, "SetInformationJobObject", win32Code);
	}
	return job;
}

/**
 * Resolve the runner's inherited standard handles.
 * @param {object} api - active binding table.
 * @returns {{stdin: bigint, stdout: bigint, stderr: bigint}} inherited handles.
 */
function inheritedStandardHandles(api) {
	const get = (selector, label) => {
		const handle = api.getStdHandle(selector);
		if (!isNullPtr(handle)) return handle;
		throwLastError(api, "GetStdHandle", `null ${label} handle`);
	};
	return {
		stdin: get(abi.STD_INPUT_HANDLE, "stdin"),
		stdout: get(abi.STD_OUTPUT_HANDLE, "stdout"),
		stderr: get(abi.STD_ERROR_HANDLE, "stderr"),
	};
}

/**
 * Call CreateProcessAsUserW for the restricted token with a NULL environment
 * block.
 * @param {object} api - active binding table.
 * @param {object} options - command, cwd, args, and restricted primary token.
 * @param {string} commandLine - quoted command line.
 * @param {number} creationFlags - CreateProcess flags.
 * @param {bigint} startupInfo - STARTUPINFOW pointer.
 * @param {bigint} processInfo - PROCESS_INFORMATION pointer.
 * @returns {number} nonzero on success.
 */
function createRestrictedProcess(api, options, commandLine, creationFlags, startupInfo, processInfo) {
	// lpEnvironment stays NULL so the child inherits the runner environment
	// untouched: the sandbox deliberately does not rewrite TMP/TEMP.
	return api.createProcessAsUserW(
		options.token,
		null,
		commandLine,
		null,
		null,
		1,
		creationFlags,
		null,
		options.cwd,
		startupInfo,
		processInfo,
	);
}

/**
 * Shared suspended-create, Job-assignment, and resume lifecycle.
 * @param {object} api - active binding table.
 * @param {object} options - command, cwd, args, and restricted primary token.
 * @param {{stdin: bigint, stdout: bigint, stderr: bigint}} stdio - handles to
 *   inherit through STARTUPINFOW.
 * @param {string} createName - Win32 API name used in diagnostics.
 * @param {(startupInfo: bigint, processInfo: bigint) => number} create - bound
 *   create call returning zero on failure.
 * @returns {{pid: number, process: bigint, job: bigint}} caller-owned handles
 *   after a successful resume.
 */
function spawnJobProcess(api, options, stdio, createName, create) {
	const job = createKillOnCloseJob(api);
	const enabled = [];
	let startupInfo;
	let processInfo;
	let created = 0;
	let createFailureCode = 0;
	try {
		const inherited = [
			[stdio.stdin, "stdin"],
			[stdio.stdout, "stdout"],
			[stdio.stderr, "stderr"],
		];
		for (const [handle, label] of inherited) {
			if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
				throwLastError(api, "SetHandleInformation", `${label} (enable inherit)`);
			}
			enabled.push(handle);
		}
		startupInfo = allocStartupInfo();
		encodeStartupInfo(startupInfo, {
			cb: abi.STARTUPINFOW_SIZE,
			// Preserve console inheritance: CREATE_NO_WINDOW / CREATE_NEW_CONSOLE
			// make restricted-token children die with STATUS_DLL_INIT_FAILED.
			dwFlags: abi.STARTF_USESTDHANDLES | abi.STARTF_USESHOWWINDOW,
			wShowWindow: abi.SW_HIDE,
			hStdInput: stdio.stdin,
			hStdOutput: stdio.stdout,
			hStdError: stdio.stderr,
		});
		processInfo = allocProcessInfo();
		created = create(startupInfo, processInfo);
		if (created === 0) createFailureCode = api.getLastError();
	} catch (error) {
		freeNative(processInfo);
		api.closeHandle(job);
		throw error;
	} finally {
		freeNative(startupInfo);
		for (const handle of enabled) {
			// The runner spawns nothing else; cleanup failure must not mask the child.
			api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, 0);
		}
	}
	if (created === 0) {
		freeNative(processInfo);
		api.closeHandle(job);
		throwWin32(api, createName, createFailureCode, `command: ${options.command}, cwd: ${options.cwd}`);
	}
	let info;
	try {
		info = decodeProcessInfo(processInfo);
	} finally {
		freeNative(processInfo);
	}
	if (info.hProcess === null || info.hThread === null) {
		if (info.hProcess !== null) api.terminateProcess(info.hProcess, 1);
		api.closeHandle(job);
		closeBestEffort(api, info.hThread);
		closeBestEffort(api, info.hProcess);
		throw new Error(
			`${createName} succeeded but returned null process/thread handles (pid ${info.dwProcessId})`,
		);
	}
	if (api.assignProcessToJobObject(job, info.hProcess) === 0) {
		const win32Code = api.getLastError();
		api.terminateProcess(info.hProcess, 1);
		closeBestEffort(api, info.hThread);
		closeBestEffort(api, info.hProcess);
		api.closeHandle(job);
		throwWin32(api, "AssignProcessToJobObject", win32Code, `pid ${info.dwProcessId}`);
	}
	// ResumeThread returns (DWORD)-1 on failure.
	if (api.resumeThread(info.hThread) === 0xffffffff) {
		const win32Code = api.getLastError();
		closeBestEffort(api, info.hThread);
		closeBestEffort(api, info.hProcess);
		api.closeHandle(job);
		throwWin32(api, "ResumeThread", win32Code, `pid ${info.dwProcessId}`);
	}
	closeBestEffort(api, info.hThread);
	return { pid: info.dwProcessId, process: info.hProcess, job };
}

/**
 * Spawn a restricted-token process suspended, assign it to a kill-on-close Job,
 * then resume its initial thread.
 * @param {object} api - active binding table.
 * @param {object} options - command, cwd, args, and restricted primary token.
 * @returns {{pid: number, process: bigint, job: bigint}} caller-owned process
 *   and Job handles after a successful resume.
 * @remarks Node clears stdio handle inheritability at startup through
 *   uv_disable_stdio_inheritance. This operation temporarily restores the bits
 *   STARTF_USESTDHANDLES requires. Restoring them afterward is best-effort:
 *   failure must not replace the already-created child's outcome.
 */
export function spawnInheritedJobProcess(api, options) {
	const commandLine = buildCommandLine(options.command, options.args);
	const stdio = inheritedStandardHandles(api);
	return spawnJobProcess(api, options, stdio, "CreateProcessAsUserW", (startupInfo, processInfo) =>
		createRestrictedProcess(api, options, commandLine, abi.CREATE_SUSPENDED, startupInfo, processInfo),
	);
}

/**
 * Wait for a process and always close its handle.
 * @param {object} api - active binding table.
 * @param {bigint} process - caller-owned process handle.
 * @returns {number} direct process exit code.
 */
export function waitForProcessExit(api, process) {
	let exitCodeSlot;
	try {
		// WAIT_FAILED; abi.js does not carry the constant.
		if (api.waitForSingleObject(process, abi.INFINITE) === 0xffffffff) {
			throwLastError(api, "WaitForSingleObject");
		}
		exitCodeSlot = allocUint32();
		if (api.getExitCodeProcess(process, exitCodeSlot) === 0) throwLastError(api, "GetExitCodeProcess");
		return decodeUint32At(exitCodeSlot, 0);
	} finally {
		freeNative(exitCodeSlot);
		api.closeHandle(process);
	}
}
