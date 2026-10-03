/**
 * Win32 call failures for the Windows ACL sandbox backend.
 *
 * Plain ESM JavaScript on purpose: the runner entry executes in a standalone
 * node process and Node refuses TypeScript type-stripping inside node_modules,
 * where the published extension lives. Relative imports here must keep the
 * `.js` extension.
 *
 * Ported from deepseek-harness (MIT)
 * `packages/subprocess/win32-process/src/errors.ts`, with the message format
 * the runner contract requires:
 * `Win32 <API> failed (<code>): <system text>[ [<detail>]]`.
 * @module
 */

/**
 * A failed Win32 call carrying the exact API name and error code.
 */
export class Win32Error extends Error {
	/**
	 * @param {string} api - Win32 function whose checked result failed.
	 * @param {number} code - exact GetLastError value or direct Win32 error code.
	 * @param {string} [detail] - text appended after the error code; callers
	 *   compose it from the FormatMessageW text and an optional operation
	 *   context (`<system text> [<context>]`).
	 */
	constructor(api, code, detail) {
		super(`Win32 ${api} failed (${code}): ${detail ?? ""}`);
		this.name = "Win32Error";
		this.api = api;
		this.code = code;
		this.detail = detail;
	}
}

/**
 * Return the FormatMessageW text for a Win32 code through the active binding
 * table, or an empty string when formatting is unavailable. A formatting
 * failure must never mask the original error.
 * @param {object} api - active Win32 binding table.
 * @param {number} code - Win32 error code.
 * @returns {string} trimmed system message, or "".
 */
export function errorText(api, code) {
	try {
		const text = api.formatMessage(code);
		return text === undefined || text === null ? "" : String(text);
	} catch {
		return "";
	}
}
