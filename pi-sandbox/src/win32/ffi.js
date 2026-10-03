/**
 * Win32 FFI bindings and native memory helpers for the Windows ACL backend.
 *
 * Plain ESM JavaScript on purpose: the runner entry executes in a standalone
 * node process and Node refuses TypeScript type-stripping inside node_modules,
 * where the published extension lives. Relative imports here must keep the
 * `.js` extension.
 *
 * Koffi is loaded lazily, and nothing native loads at import time: the memory
 * and pointer helpers work on every platform (unit tests use the real koffi),
 * while the Win32 binding table loads kernel32.dll/advapi32.dll only on win32
 * hosts. Importing this module must never load koffi or a DLL.
 *
 * Bindings, layouts, and helpers are ported from deepseek-harness (MIT):
 * - `packages/sandbox/sandbox-windows-acl/src/ffi.ts`: ACL/token bindings,
 *   pointer helpers, GetTempPathW decoding.
 * - `packages/subprocess/win32-process/src/ffi.ts`: process/Job/stdio
 *   bindings, STARTUPINFOW/PROCESS_INFORMATION layouts, error helpers.
 * - `packages/subprocess/win32-process/src/errors.ts`: Win32Error (see
 *   `./errors.js`).
 * The stdcall convention is explicit in `bind`, as in both reference files;
 * koffi ignores it outside x86 and it is the only convention on x64.
 * @module
 */

import { createRequire } from "node:module";
import * as abi from "./abi.js";
import { Win32Error, errorText } from "./errors.js";

const require = createRequire(import.meta.url);

/** FormatMessageW flag selecting the system message table. */
const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000;
/** FormatMessageW flag keeping %1-style insert sequences untouched. */
const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200;

let cachedKoffi;

/**
 * Load koffi lazily. Koffi is available on every platform; only the Win32
 * binding table is win32-specific.
 * @returns {object} the koffi module.
 */
export function requireKoffi() {
	cachedKoffi ??= require("koffi");
	return cachedKoffi;
}

/**
 * Return the lazily loaded koffi module (Task 6 seam for record allocation).
 * @returns {object} the koffi module.
 */
export function koffiLib() {
	return requireKoffi();
}

let cachedTypes;

/**
 * Materialize the koffi types once: `void *`, its pointer, the `uint32 *`
 * out-parameter pointer, and the two process records. Building record types
 * only needs koffi, not a Win32 host, so the x64 size asserts also run in the
 * Linux unit tests.
 * @returns {object} cached koffi types (`PVOID`, `PPVOID`, `PUINT32`,
 *   `STARTUPINFOW`, `PROCESS_INFORMATION`).
 */
export function ffiTypes() {
	if (cachedTypes !== undefined) return cachedTypes;
	const koffi = koffiLib();
	const PVOID = koffi.pointer("void");
	const PPVOID = koffi.pointer(PVOID);
	const PUINT32 = koffi.pointer("uint32");
	const STARTUPINFOW = koffi.struct("PI_STARTUPINFOW", {
		cb: "uint32",
		lpReserved: "str16",
		lpDesktop: "str16",
		lpTitle: "str16",
		dwX: "uint32",
		dwY: "uint32",
		dwXSize: "uint32",
		dwYSize: "uint32",
		dwXCountChars: "uint32",
		dwYCountChars: "uint32",
		dwFillAttribute: "uint32",
		dwFlags: "uint32",
		wShowWindow: "uint16",
		cbReserved2: "uint16",
		lpReserved2: koffi.pointer("uint8"),
		hStdInput: PVOID,
		hStdOutput: PVOID,
		hStdError: PVOID,
	});
	const PROCESS_INFORMATION = koffi.struct("PI_PROCESS_INFORMATION", {
		hProcess: PVOID,
		hThread: PVOID,
		dwProcessId: "uint32",
		dwThreadId: "uint32",
	});
	if (STARTUPINFOW.size !== abi.STARTUPINFOW_SIZE) {
		throw new Error(
			`STARTUPINFOW layout mismatch: koffi computed ${STARTUPINFOW.size}, expected ${abi.STARTUPINFOW_SIZE}`,
		);
	}
	if (PROCESS_INFORMATION.size !== abi.PROCESS_INFORMATION_SIZE) {
		throw new Error(
			`PROCESS_INFORMATION layout mismatch: koffi computed ${PROCESS_INFORMATION.size}, expected ${abi.PROCESS_INFORMATION_SIZE}`,
		);
	}
	cachedTypes = { PVOID, PPVOID, PUINT32, STARTUPINFOW, PROCESS_INFORMATION };
	return cachedTypes;
}

/**
 * Return the STARTUPINFOW record type (Task 6 seam).
 * @returns {object} koffi record type.
 */
export function startupInfoType() {
	return ffiTypes().STARTUPINFOW;
}

/**
 * Return the PROCESS_INFORMATION record type (Task 6 seam).
 * @returns {object} koffi record type.
 */
export function processInformationType() {
	return ffiTypes().PROCESS_INFORMATION;
}

/**
 * Return whether a koffi pointer or native value represents NULL.
 * @param {bigint|null|undefined} value - pointer value returned by koffi or a
 *   Win32 call.
 * @returns {boolean} true for null, undefined, or address zero.
 */
export function isNullPtr(value) {
	return value === null || value === undefined || value === 0n;
}

/**
 * Return whether a handle is CreateFileW's INVALID_HANDLE_VALUE.
 * @param {bigint|null|undefined} handle - handle returned by CreateFileW.
 * @returns {boolean} true for null, zero, or the all-bits-one sentinel.
 */
export function isInvalidHandle(handle) {
	if (isNullPtr(handle)) return true;
	return handle === 0xffffffffffffffffn || handle === -1n;
}

/**
 * Allocate one pointer-sized out-parameter slot.
 * @returns {bigint} allocated native slot.
 */
export function allocPtrSlot() {
	return requireKoffi().alloc(ffiTypes().PVOID, 1);
}

/**
 * Allocate one uint32 out-parameter slot.
 * @returns {bigint} allocated native slot.
 */
export function allocUint32() {
	return requireKoffi().alloc("uint32", 1);
}

/**
 * Allocate a raw zeroed byte block.
 * @param {number} length - byte count.
 * @returns {bigint} allocated pointer.
 */
export function allocBytes(length) {
	return requireKoffi().alloc("uint8", length);
}

/**
 * Allocate one zeroed x64 OVERLAPPED record.
 * @returns {bigint} allocated pointer.
 * @remarks Koffi 3.1.1 crashes when LockFileEx or UnlockFileEx receives NULL;
 *   a zeroed OVERLAPPED is equivalent for the synchronous lock-file handle.
 */
export function allocOverlapped() {
	return allocBytes(32);
}

/**
 * Release native memory returned by `allocBytes`/`allocPtrSlot`/`allocUint32`
 * before garbage collection would. Do not call it on handles or on memory
 * owned by Win32 (use `LocalFree` for LocalAlloc output).
 * @param {bigint} ptr - pointer allocated by this module.
 */
export function freeNative(ptr) {
	requireKoffi().free(ptr);
}

/**
 * Decode a pointer out-parameter.
 * @param {bigint} slot - pointer-sized slot filled by Win32.
 * @returns {bigint|null} decoded pointer, or null for address zero.
 */
export function decodePtr(slot) {
	const value = requireKoffi().decode(slot, ffiTypes().PVOID);
	return isNullPtr(value) ? null : value;
}

/**
 * Decode a pointer value from a Buffer field.
 * @param {Buffer} buffer - encoded native record.
 * @param {number} offset - pointer field byte offset.
 * @returns {bigint|null} decoded pointer, or null for address zero.
 */
export function decodePtrAt(buffer, offset) {
	const value = requireKoffi().decode(buffer, offset, ffiTypes().PVOID);
	return isNullPtr(value) ? null : value;
}

/**
 * Decode a uint8 field at a native pointer offset.
 * @param {bigint} ptr - native record pointer.
 * @param {number} offset - field byte offset.
 * @returns {number} decoded value.
 */
export function decodeUint8At(ptr, offset) {
	return requireKoffi().decode(ptr, offset, "uint8");
}

/**
 * Decode a uint16 field at a native pointer offset.
 * @param {bigint} ptr - native record pointer.
 * @param {number} offset - field byte offset.
 * @returns {number} decoded value.
 */
export function decodeUint16At(ptr, offset) {
	return requireKoffi().decode(ptr, offset, "uint16");
}

/**
 * Decode a uint32 field at a native pointer offset.
 * @param {bigint} ptr - native record pointer.
 * @param {number} offset - field byte offset.
 * @returns {number} decoded value.
 */
export function decodeUint32At(ptr, offset) {
	return requireKoffi().decode(ptr, offset, "uint32");
}

/**
 * Encode a uint32 into an allocated slot.
 * @param {bigint} slot - slot allocated by `allocUint32`.
 * @param {number} value - unsigned value to store.
 */
export function encodeUint32(slot, value) {
	requireKoffi().encode(slot, "uint32", value);
}

/**
 * Return a koffi pointer's numeric address for struct packing.
 * @param {bigint} ptr - native pointer.
 * @returns {bigint} pointer address.
 */
export function ptrAddress(ptr) {
	return requireKoffi().address(ptr);
}

/**
 * Compare two in-memory SID records without allocating strings.
 * @param {bigint} left - first native buffer.
 * @param {number} leftOffset - first SID byte offset.
 * @param {bigint} right - second native buffer.
 * @param {number} rightOffset - second SID byte offset.
 * @returns {boolean} true when revision, authority, and every sub-authority
 *   match.
 */
export function sameSidAt(left, leftOffset, right, rightOffset) {
	if (decodeUint8At(left, leftOffset) !== decodeUint8At(right, rightOffset)) return false;
	const leftCount = decodeUint8At(left, leftOffset + 1);
	const rightCount = decodeUint8At(right, rightOffset + 1);
	if (leftCount !== rightCount || leftCount > abi.SID_MAX_SUB_AUTHORITIES) return false;
	for (let index = 0; index < 6; index += 1) {
		if (decodeUint8At(left, leftOffset + 2 + index) !== decodeUint8At(right, rightOffset + 2 + index)) {
			return false;
		}
	}
	for (let index = 0; index < leftCount; index += 1) {
		if (decodeUint32At(left, leftOffset + 8 + index * 4) !== decodeUint32At(right, rightOffset + 8 + index * 4)) {
			return false;
		}
	}
	return true;
}

/**
 * Format a Win32 error code through FormatMessageW.
 * @param {Function} formatMessageW - bound FormatMessageW.
 * @param {number} code - captured GetLastError value.
 * @returns {string} trimmed system message, or an empty string.
 */
function formatMessageText(formatMessageW, code) {
	const buffer = Buffer.alloc(1024);
	const length = formatMessageW(
		FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
		null,
		code,
		0,
		buffer,
		buffer.length / 2,
		null,
	);
	return length === 0
		? ""
		: buffer
				.subarray(0, length * 2)
				.toString("utf16le")
				.trim();
}

/**
 * Bind every kernel32/advapi32 function the Windows ACL backend needs.
 *
 * ACL/token signatures come from `sandbox-windows-acl/src/ffi.ts` verbatim;
 * the process/Job subset comes from `win32-process/src/ffi.ts`. Deliberately
 * not ported: SetEnvironmentVariableW (the design does not rewrite TMP/TEMP)
 * and the piped-stdio/Pipe APIs. SetConsoleCtrlHandler stays because the
 * runner installs a Ctrl+C handler before spawning.
 * @param {object} kernel32 - loaded kernel32.dll.
 * @param {object} advapi32 - loaded advapi32.dll.
 * @param {Function} bind - shared stdcall binder (`library.func`).
 * @returns {object} the flat binding table.
 */
function allBindings(kernel32, advapi32, bind) {
	const koffi = koffiLib();
	const { PVOID, PPVOID, PUINT32, STARTUPINFOW, PROCESS_INFORMATION } = ffiTypes();
	const formatMessageW = bind(kernel32, "FormatMessageW", "uint32", [
		"uint32",
		PVOID,
		"uint32",
		"uint32",
		PVOID,
		"uint32",
		PVOID,
	]);
	return {
		// --- ACL, SID, and token calls ---
		openProcess: bind(kernel32, "OpenProcess", PVOID, ["uint32", "int", "uint32"]),
		openProcessToken: bind(advapi32, "OpenProcessToken", "int", [PVOID, "uint32", PPVOID]),
		localAlloc: bind(kernel32, "LocalAlloc", PVOID, ["uint32", "size_t"]),
		localFree: bind(kernel32, "LocalFree", PVOID, [PVOID]),
		convertStringSidToSidW: bind(advapi32, "ConvertStringSidToSidW", "int", ["str16", PPVOID]),
		createWellKnownSid: bind(advapi32, "CreateWellKnownSid", "int", ["int", PVOID, PVOID, PUINT32]),
		isValidSid: bind(advapi32, "IsValidSid", "int", [PVOID]),
		getLengthSid: bind(advapi32, "GetLengthSid", "uint32", [PVOID]),
		copySid: bind(advapi32, "CopySid", "int", ["uint32", PVOID, PVOID]),
		getTokenInformation: bind(advapi32, "GetTokenInformation", "int", [PVOID, "int", PVOID, "uint32", PUINT32]),
		setTokenInformation: bind(advapi32, "SetTokenInformation", "int", [PVOID, "int", PVOID, "uint32"]),
		createRestrictedToken: bind(advapi32, "CreateRestrictedToken", "int", [
			PVOID,
			"uint32",
			"uint32",
			PVOID,
			"uint32",
			PVOID,
			"uint32",
			PVOID,
			PPVOID,
		]),
		setEntriesInAclW: bind(advapi32, "SetEntriesInAclW", "uint32", ["uint32", PVOID, PVOID, PPVOID]),
		initializeAcl: bind(advapi32, "InitializeAcl", "int", [PVOID, "uint32", "uint32"]),
		addMandatoryAce: bind(advapi32, "AddMandatoryAce", "int", [PVOID, "uint32", "uint32", "uint32", PVOID]),
		setNamedSecurityInfoW: bind(advapi32, "SetNamedSecurityInfoW", "uint32", [
			"str16",
			"int",
			"uint32",
			PVOID,
			PVOID,
			PVOID,
			PVOID,
		]),
		getNamedSecurityInfoW: bind(advapi32, "GetNamedSecurityInfoW", "uint32", [
			"str16",
			"int",
			"uint32",
			PPVOID,
			PPVOID,
			PPVOID,
			PPVOID,
			PPVOID,
		]),
		getTempPathW: bind(kernel32, "GetTempPathW", "uint32", ["uint32", PVOID]),
		createFileW: bind(kernel32, "CreateFileW", PVOID, ["str16", "uint32", "uint32", PVOID, "uint32", "uint32", PVOID]),
		lockFileEx: bind(kernel32, "LockFileEx", "int", [PVOID, "uint32", "uint32", "uint32", "uint32", PVOID]),
		unlockFileEx: bind(kernel32, "UnlockFileEx", "int", [PVOID, "uint32", "uint32", "uint32", PVOID]),

		// --- Process, stdio, and Job calls ---
		getLastError: bind(kernel32, "GetLastError", "uint32", []),
		closeHandle: bind(kernel32, "CloseHandle", "int", [PVOID]),
		setHandleInformation: bind(kernel32, "SetHandleInformation", "int", [PVOID, "uint32", "uint32"]),
		setConsoleCtrlHandler: bind(kernel32, "SetConsoleCtrlHandler", "int", [PVOID, "int"]),
		createProcessAsUserW: bind(advapi32, "CreateProcessAsUserW", "int", [
			PVOID,
			"str16",
			"str16",
			PVOID,
			PVOID,
			"int",
			"uint32",
			PVOID,
			"str16",
			koffi.pointer(STARTUPINFOW),
			koffi.pointer(PROCESS_INFORMATION),
		]),
		createJobObjectW: bind(kernel32, "CreateJobObjectW", PVOID, [PVOID, "str16"]),
		setInformationJobObject: bind(kernel32, "SetInformationJobObject", "int", [PVOID, "int", PVOID, "uint32"]),
		assignProcessToJobObject: bind(kernel32, "AssignProcessToJobObject", "int", [PVOID, PVOID]),
		resumeThread: bind(kernel32, "ResumeThread", "uint32", [PVOID]),
		terminateProcess: bind(kernel32, "TerminateProcess", "int", [PVOID, "uint32"]),
		waitForSingleObject: bind(kernel32, "WaitForSingleObject", "uint32", [PVOID, "uint32"]),
		getExitCodeProcess: bind(kernel32, "GetExitCodeProcess", "int", [PVOID, PUINT32]),
		getStdHandle: bind(kernel32, "GetStdHandle", PVOID, ["int"]),

		// --- Provided by this module on top of the raw Win32 calls ---
		formatMessageW,
		/**
		 * Format a Win32 error code through FormatMessageW.
		 * @param {number} code - captured GetLastError value.
		 * @returns {string} trimmed system message, or an empty string.
		 */
		formatMessage(code) {
			return formatMessageText(formatMessageW, code);
		},
		/** STARTUPINFOW record type for process allocation (Task 6). */
		STARTUPINFOW,
		/** PROCESS_INFORMATION record type for process allocation (Task 6). */
		PROCESS_INFORMATION,
	};
}

let cachedBindings;

/**
 * Load the Win32 binding table. Fails before touching koffi or any DLL on
 * non-win32 hosts.
 * @returns {object} the binding table.
 */
function createBindings() {
	if (process.platform !== "win32") {
		throw new Error("win32 ffi: the Win32 binding table is only available on win32 hosts");
	}
	const koffi = koffiLib();
	const kernel32 = koffi.load("kernel32.dll");
	const advapi32 = koffi.load("advapi32.dll");
	// The reference binders pass '__stdcall' explicitly; koffi ignores the
	// convention on non-x86 hosts and x64 has a single Windows convention.
	const bind = (library, name, result, args) => library.func("__stdcall", name, result, args);
	return { kernel32, advapi32, bind, ...allBindings(kernel32, advapi32, bind) };
}

/**
 * Resolve the cached Win32 binding table.
 * @returns {object} the cached binding table.
 */
function bindings() {
	if (cachedBindings !== undefined) return cachedBindings;
	cachedBindings = createBindings();
	return cachedBindings;
}

/**
 * Resolve the cached Win32 binding table asynchronously.
 * @returns {Promise<object>} kernel32/advapi32 bindings plus helpers.
 */
export function win32() {
	return Promise.resolve(bindings());
}

/**
 * Resolve the cached Win32 binding table synchronously.
 * @returns {object} kernel32/advapi32 bindings plus helpers.
 */
export function win32Sync() {
	return bindings();
}

/**
 * Resolve the current Windows temporary directory.
 * @param {object} api - active Win32 binding table.
 * @returns {string} UTF-16 path reported by GetTempPathW.
 */
export function getTempPath(api) {
	const buffer = Buffer.alloc((abi.MAX_PATH + 1) * 2);
	const length = api.getTempPathW(buffer.length / 2, buffer);
	if (length === 0) throwLastError(api, "GetTempPathW");
	if (length > buffer.length / 2) {
		throwWin32(
			api,
			"GetTempPathW",
			abi.ERROR_INSUFFICIENT_BUFFER,
			`required ${length} chars exceed the ${buffer.length / 2}-char buffer; nothing was written`,
		);
	}
	return buffer.subarray(0, length * 2).toString("utf16le");
}

/**
 * Throw an explicitly captured Win32 error code.
 * @param {object} api - active Win32 binding table.
 * @param {string} name - failing Win32 operation.
 * @param {number} code - error captured before cleanup.
 * @param {string} [detail] - optional operation context, appended in brackets.
 * @returns {never} always throws Win32Error.
 */
export function throwWin32(api, name, code, detail) {
	const text = errorText(api, code);
	throw new Win32Error(name, code, detail === undefined ? text : `${text} [${detail}]`);
}

/**
 * Throw the current GetLastError value.
 * @param {object} api - active Win32 binding table.
 * @param {string} name - failing Win32 operation.
 * @param {string} [detail] - optional operation context, appended in brackets.
 * @returns {never} always throws Win32Error.
 */
export function throwLastError(api, name, detail) {
	throwWin32(api, name, api.getLastError(), detail);
}
