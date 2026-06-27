/**
 * recover-subagents.ts — Rebuild navigable subagent descriptors from disk.
 *
 * When a session is resumed or forked, the in-memory `SubagentManager` starts
 * empty (the extension is re-instantiated per session). The child sessions'
 * transcripts still live on disk, and a `subagents:record` custom entry was
 * appended to the *parent* session file on each completion — carrying the
 * metadata (and, since this fix, the transcript `outputFile`) needed to label
 * and source them. This module parses those entries back into `EvictedSubagent`
 * descriptors so `/subagents:sessions` can show them again after resume/fork.
 *
 * Pure: takes the parent session file path and a `readFile` seam, returns
 * descriptors. Makes no `fs` calls and stays free of SDK objects beyond the
 * shared `FileEntry`/`CustomEntry` parse result.
 */

import { type CustomEntry, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { EvictedSubagent } from "../lifecycle/subagent-manager";
import type { SubagentStatus } from "../lifecycle/subagent-state";
import type { SubagentType } from "../types";

/** The customType under which completed-subagent records are persisted. */
export const SUBAGENT_RECORD_CUSTOM_TYPE = "subagents:record";

/** Fields persisted on each `subagents:record` entry (see onSubagentCompleted). */
interface PersistedSubagentRecord {
	id: string;
	type: SubagentType;
	description: string;
	status: SubagentStatus;
	result?: string;
	error?: string;
	startedAt: number;
	completedAt: number | undefined;
	toolUses?: number;
	modelName?: string;
	outputFile?: string;
}

/**
 * Read the parent session file and rebuild `EvictedSubagent` descriptors from
 * its `subagents:record` entries, most-recent-first. Records without an
 * `outputFile` are dropped — their transcript is not navigable from disk.
 *
 * Returns `[]` when the parent session is not persisted (no file) or the file
 * cannot be read, so callers can invoke unconditionally on session start.
 */
export function recoverEvictedSubagents(
	parentSessionFile: string | undefined,
	readFile: (path: string) => string,
): EvictedSubagent[] {
	if (!parentSessionFile) return [];
	let entries: ReturnType<typeof parseSessionEntries>;
	try {
		entries = parseSessionEntries(readFile(parentSessionFile));
	} catch {
		return [];
	}

	const records = entries.filter(
		(entry): entry is CustomEntry =>
			entry.type === "custom" && (entry as CustomEntry).customType === SUBAGENT_RECORD_CUSTOM_TYPE,
	);

	const recovered: EvictedSubagent[] = [];
	for (const entry of records) {
		const data = (entry.data ?? {}) as PersistedSubagentRecord;
		if (!data.outputFile) continue; // not navigable from disk
		recovered.push({
			id: data.id,
			type: data.type,
			description: data.description,
			status: data.status,
			startedAt: data.startedAt,
			completedAt: data.completedAt,
			toolUses: data.toolUses ?? 0,
			modelName: data.modelName,
			outputFile: data.outputFile,
		});
	}
	// Most-recent-first, matching listEvicted()'s ordering.
	recovered.sort((a, b) => b.startedAt - a.startedAt);
	return recovered;
}
