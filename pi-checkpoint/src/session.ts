import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DiffPreview } from "./diff.js";
import type { RecordedCheckpointCommit } from "./refs.js";

export const CHECKPOINT_ENTRY_TYPE = "pi-checkpoint";

export interface CheckpointBaseData {
	version: 1;
	status: "ok" | "error";
	runId: string;
	runNumber: number;
	previousLeafId: string | null;
	sourceEntryId: string | null;
	messageType: "user" | "custom";
	startedAt: string;
	settledAt: string | null;
	aborted: boolean;
}

export interface CheckpointOkData extends CheckpointBaseData, DiffPreview {
	status: "ok";
	settledAt: string;
	ref: string;
	baselineCommit: string;
	resultCommit: string;
	headBefore: string | null;
	headAfter: string | null;
	/**
	 * Common Git dir of the repository that holds the snapshot. Entries written before this field
	 * existed have none; a query then falls back to the current directory and uses hedged wording.
	 */
	commonDir?: string;
}

export interface CheckpointErrorData extends CheckpointBaseData {
	status: "error";
	stage: "baseline" | "result";
	ref: string;
	baselineCommit: string | null;
	error: string;
}

export type CheckpointEntryData = CheckpointOkData | CheckpointErrorData;

export function parseCheckpointEntryData(value: unknown): CheckpointEntryData | null {
	if (!isRecord(value) || !hasBaseShape(value)) return null;
	if (value.status === "ok") {
		if (
			typeof value.settledAt !== "string" ||
			typeof value.ref !== "string" ||
			typeof value.baselineCommit !== "string" ||
			typeof value.resultCommit !== "string" ||
			!isNullableString(value.headBefore) ||
			!isNullableString(value.headAfter) ||
			!isNullableString(value.shortstat) ||
			!isNullableString(value.patchPreview) ||
			typeof value.previewTruncated !== "boolean" ||
			!isNullableString(value.previewError) ||
			!isOptionalString(value.commonDir)
		) {
			return null;
		}
		return {
			version: 1,
			status: "ok",
			runId: value.runId,
			runNumber: value.runNumber,
			previousLeafId: value.previousLeafId,
			sourceEntryId: value.sourceEntryId,
			messageType: value.messageType,
			startedAt: value.startedAt,
			settledAt: value.settledAt,
			aborted: value.aborted,
			ref: value.ref,
			baselineCommit: value.baselineCommit,
			resultCommit: value.resultCommit,
			headBefore: value.headBefore,
			headAfter: value.headAfter,
			...(value.commonDir === undefined ? {} : { commonDir: value.commonDir }),
			shortstat: value.shortstat,
			patchPreview: value.patchPreview,
			previewTruncated: value.previewTruncated,
			previewError: value.previewError,
		};
	}
	if (
		(value.stage !== "baseline" && value.stage !== "result") ||
		typeof value.ref !== "string" ||
		!isNullableString(value.baselineCommit) ||
		typeof value.error !== "string"
	) {
		return null;
	}
	return {
		version: 1,
		status: "error",
		runId: value.runId,
		runNumber: value.runNumber,
		previousLeafId: value.previousLeafId,
		sourceEntryId: value.sourceEntryId,
		messageType: value.messageType,
		startedAt: value.startedAt,
		settledAt: value.settledAt,
		aborted: value.aborted,
		stage: value.stage,
		ref: value.ref,
		baselineCommit: value.baselineCommit,
		error: value.error,
	};
}

/**
 * Snapshot commits this session's entries assert for each ref. Pruning only uses them to cross-check
 * refs it can see; refs from other sessions have no entry here and fall back to commit structure.
 */
export function recordedSnapshots(entries: readonly SessionEntry[]): Map<string, RecordedCheckpointCommit> {
	const recorded = new Map<string, RecordedCheckpointCommit>();
	for (const entry of entries) {
		const data = checkpointDataFromEntry(entry);
		if (data?.status !== "ok") continue;
		recorded.set(data.ref, {
			ref: data.ref,
			baselineCommit: data.baselineCommit,
			resultCommit: data.resultCommit,
		});
	}
	return recorded;
}

export function nextRunNumber(entries: readonly SessionEntry[]): number {
	let maximum = 0;
	for (const entry of entries) {
		const data = checkpointDataFromEntry(entry);
		if (data) maximum = Math.max(maximum, data.runNumber);
	}
	return maximum + 1;
}

export function findCheckpoint(entries: readonly SessionEntry[], runNumber: number): CheckpointEntryData | null {
	if (!Number.isInteger(runNumber) || runNumber < 1) return null;
	for (const entry of entries) {
		const data = checkpointDataFromEntry(entry);
		if (data?.runNumber === runNumber) return data;
	}
	return null;
}

export function resolveSourceEntryId(
	entries: readonly SessionEntry[],
	previousLeafId: string | null,
	messageType: "user" | "custom",
): string | null {
	if (!previousLeafId || messageType !== "user") return null;
	const anchorIndex = entries.findIndex((entry) => entry.id === previousLeafId);
	if (anchorIndex < 0) return null;
	const source = entries
		.slice(anchorIndex + 1)
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	return source?.id ?? null;
}

function checkpointDataFromEntry(entry: SessionEntry): CheckpointEntryData | null {
	if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY_TYPE) return null;
	return parseCheckpointEntryData(entry.data);
}

function hasBaseShape(value: Record<string, unknown>): value is CheckpointBaseData & Record<string, unknown> {
	return (
		value.version === 1 &&
		(value.status === "ok" || value.status === "error") &&
		typeof value.runId === "string" &&
		typeof value.runNumber === "number" &&
		Number.isInteger(value.runNumber) &&
		value.runNumber >= 1 &&
		isNullableString(value.previousLeafId) &&
		isNullableString(value.sourceEntryId) &&
		(value.messageType === "user" || value.messageType === "custom") &&
		typeof value.startedAt === "string" &&
		isNullableString(value.settledAt) &&
		typeof value.aborted === "boolean"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}
