import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";

import { isPermissionDecisionState } from "../permission-dialog";
import type { PermissionUiPromptSource } from "../permission-events";
import {
	createPermissionForwardingLocation,
	type ForwardedPermissionRequest,
	type ForwardedPermissionResponse,
	type PermissionForwardingLocation,
} from "../permission-forwarding";
import type { DebugReviewLogger } from "../session-logger";

/** Valid `permissions:ui_prompt` source values, for tolerant request reads. */
const UI_PROMPT_SOURCES = [
	"tool_call",
	"skill_input",
	"skill_read",
	"rpc_prompt",
] as const satisfies readonly PermissionUiPromptSource[];

/** Narrow an unknown value to a valid prompt source, or `undefined`. */
function asUiPromptSource(value: unknown): PermissionUiPromptSource | undefined {
	return UI_PROMPT_SOURCES.find((source) => source === value);
}

/** Narrow an unknown value to a nullable display string, or `undefined`. */
function asNullableDisplayString(value: unknown): string | null | undefined {
	if (value === null || typeof value === "string") {
		return value;
	}
	return undefined;
}

export function formatUnknownErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return String(error);
}

export function isErrnoCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}

/**
 * Log a warning to both the review and debug logs.
 * Pass `null` for `logger` to silently no-op (e.g. in unit tests without IO).
 */
export function logPermissionForwardingWarning(
	logger: DebugReviewLogger | null,
	message: string,
	error?: unknown,
): void {
	const details = typeof error === "undefined" ? { message } : { message, error: formatUnknownErrorMessage(error) };

	logger?.review("permission_forwarding.warning", details);
	logger?.debug("permission_forwarding.warning", details);
}

/**
 * Log an error to both the review and debug logs.
 * Pass `null` for `logger` to silently no-op (e.g. in unit tests without IO).
 */
export function logPermissionForwardingError(logger: DebugReviewLogger | null, message: string, error?: unknown): void {
	const details = typeof error === "undefined" ? { message } : { message, error: formatUnknownErrorMessage(error) };

	logger?.review("permission_forwarding.error", details);
	logger?.debug("permission_forwarding.error", details);
}

export function ensureDirectoryExists(logger: DebugReviewLogger | null, path: string, description: string): boolean {
	try {
		mkdirSync(path, { recursive: true });
		return true;
	} catch (error) {
		logPermissionForwardingError(logger, `Failed to create ${description} directory '${path}'`, error);
		return false;
	}
}

export function getPermissionForwardingLocationForSession(
	forwardingDir: string,
	sessionId: string,
): PermissionForwardingLocation {
	return createPermissionForwardingLocation(forwardingDir, sessionId);
}

export function ensurePermissionForwardingLocation(
	logger: DebugReviewLogger | null,
	forwardingDir: string,
	sessionId: string,
): PermissionForwardingLocation | null {
	let location: PermissionForwardingLocation;
	try {
		location = getPermissionForwardingLocationForSession(forwardingDir, sessionId);
	} catch (error) {
		logPermissionForwardingError(logger, "Failed to resolve permission forwarding location", error);
		return null;
	}

	const sessionRootReady = ensureDirectoryExists(logger, location.sessionRootDir, "permission forwarding session root");
	const requestsReady = ensureDirectoryExists(logger, location.requestsDir, "permission forwarding requests");
	const responsesReady = ensureDirectoryExists(logger, location.responsesDir, "permission forwarding responses");

	return sessionRootReady && requestsReady && responsesReady ? location : null;
}

export function getExistingPermissionForwardingLocation(
	forwardingDir: string,
	sessionId: string,
): PermissionForwardingLocation | null {
	let location: PermissionForwardingLocation;
	try {
		location = getPermissionForwardingLocationForSession(forwardingDir, sessionId);
	} catch {
		return null;
	}

	return existsSync(location.requestsDir) ? location : null;
}

/**
 * Attempt to remove a directory if it is empty.
 *
 * Returns `true` when the directory is absent after the call (successfully
 * removed, or never existed).  Returns `false` when the directory still exists
 * (non-empty, or a filesystem error prevented removal).
 */
export function tryRemoveDirectoryIfEmpty(
	logger: DebugReviewLogger | null,
	path: string,
	description: string,
): boolean {
	if (!existsSync(path)) {
		return true;
	}

	let entries: string[];
	try {
		entries = readdirSync(path);
	} catch (error) {
		logPermissionForwardingWarning(logger, `Failed to inspect ${description} directory '${path}'`, error);
		return false;
	}

	if (entries.length > 0) {
		return false;
	}

	try {
		rmdirSync(path);
		return true;
	} catch (error) {
		if (isErrnoCode(error, "ENOENT")) {
			return true;
		}
		if (isErrnoCode(error, "ENOTEMPTY")) {
			return false;
		}

		logPermissionForwardingWarning(logger, `Failed to remove empty ${description} directory '${path}'`, error);
		return false;
	}
}

export function cleanupPermissionForwardingLocationIfEmpty(
	logger: DebugReviewLogger | null,
	location: PermissionForwardingLocation,
): void {
	// Only remove responses/ when requests/ is already gone — removing responses/
	// while a request is still pending causes the ENOENT write loop (issue #398).
	const requestsGone = tryRemoveDirectoryIfEmpty(
		logger,
		location.requestsDir,
		`${location.label} permission forwarding requests`,
	);
	if (requestsGone) {
		tryRemoveDirectoryIfEmpty(logger, location.responsesDir, `${location.label} permission forwarding responses`);
	}
	tryRemoveDirectoryIfEmpty(logger, location.sessionRootDir, `${location.label} permission forwarding session root`);
}

export function safeDeleteFile(logger: DebugReviewLogger | null, filePath: string, description: string): void {
	try {
		unlinkSync(filePath);
	} catch (error) {
		if (isErrnoCode(error, "ENOENT")) {
			return;
		}

		logPermissionForwardingWarning(logger, `Failed to delete ${description} file '${filePath}'`, error);
	}
}

export function writeJsonFileAtomic(logger: DebugReviewLogger | null, filePath: string, value: unknown): void {
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

	try {
		writeFileSync(tempPath, JSON.stringify(value), "utf-8");
		renameSync(tempPath, filePath);
	} catch (error) {
		safeDeleteFile(logger, tempPath, "temporary permission-forwarding");
		throw error;
	}
}

export function readForwardedPermissionRequest(
	logger: DebugReviewLogger | null,
	filePath: string,
): ForwardedPermissionRequest | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<ForwardedPermissionRequest>;
		if (
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.parse can return null for the string "null"
			!parsed ||
			typeof parsed.id !== "string" ||
			typeof parsed.createdAt !== "number" ||
			typeof parsed.requesterSessionId !== "string" ||
			typeof parsed.targetSessionId !== "string" ||
			typeof parsed.requesterAgentName !== "string" ||
			typeof parsed.message !== "string"
		) {
			logPermissionForwardingWarning(logger, `Ignoring invalid forwarded permission request format in '${filePath}'`);
			return null;
		}

		return {
			id: parsed.id,
			createdAt: parsed.createdAt,
			requesterSessionId: parsed.requesterSessionId,
			targetSessionId: parsed.targetSessionId,
			requesterAgentName: parsed.requesterAgentName,
			message: parsed.message,
			// Tolerant read: display fields are optional and may be absent (older
			// child) or malformed; reconstruct only the well-formed ones.
			source: asUiPromptSource(parsed.source),
			surface: asNullableDisplayString(parsed.surface),
			value: asNullableDisplayString(parsed.value),
		};
	} catch (error) {
		logPermissionForwardingWarning(logger, `Failed to read forwarded permission request '${filePath}'`, error);
		return null;
	}
}

export function readForwardedPermissionResponse(
	logger: DebugReviewLogger | null,
	filePath: string,
): ForwardedPermissionResponse | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<ForwardedPermissionResponse>;
		if (
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.parse can return null for the string "null"
			!parsed ||
			typeof parsed.approved !== "boolean" ||
			!isPermissionDecisionState(parsed.state) ||
			typeof parsed.responderSessionId !== "string"
		) {
			logPermissionForwardingWarning(logger, `Ignoring invalid forwarded permission response format in '${filePath}'`);
			return null;
		}

		return {
			approved: parsed.approved,
			state: parsed.state,
			denialReason: typeof parsed.denialReason === "string" ? parsed.denialReason : undefined,
			responderSessionId: parsed.responderSessionId,
			respondedAt: typeof parsed.respondedAt === "number" ? parsed.respondedAt : Date.now(),
		};
	} catch (error) {
		logPermissionForwardingWarning(logger, `Failed to read forwarded permission response '${filePath}'`, error);
		return null;
	}
}

export function listRequestFiles(logger: DebugReviewLogger | null, requestsDir: string): string[] {
	try {
		return readdirSync(requestsDir)
			.filter((name) => name.endsWith(".json"))
			.sort();
	} catch (error) {
		logPermissionForwardingWarning(logger, `Failed to read permission forwarding requests from '${requestsDir}'`, error);
		return [];
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
