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
 * Pure: takes the parent session file path, a `readFile` seam, and an optional
 * `exists` seam (defaults to a readFile-based probe), returns descriptors. The
 * default keeps the function free of direct `fs` calls; callers may pass
 * `fs.existsSync` to avoid reading the whole file just to check existence.
 */

import { join } from "node:path";
import { type CustomEntry, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { EvictedSubagent } from "../lifecycle/subagent-manager";
import type { SubagentStatus } from "../lifecycle/subagent-state";
import type { SubagentType } from "../types";
import { deriveSubagentSessionDir } from "./session-dir";

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
	thinking?: string;
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
	exists: (path: string) => boolean = (path) => {
		try {
			readFile(path);
			return true;
		} catch {
			return false;
		}
	},
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
	// Derive the tasks directory once for fallback outputFile construction.
	// The empty cwd is harmless: when parentSessionFile is set, session-dir
	// derives the path from it and ignores cwd entirely.
	const tasksDir = deriveSubagentSessionDir(parentSessionFile, "");
	for (const entry of records) {
		const data = (entry.data ?? {}) as PersistedSubagentRecord;
		// Try to determine outputFile: prefer the persisted one, else construct
		// from the agent id and tasks directory (backwards compat for pre-fix records).
		let outputFile: string | undefined = data.outputFile;
		if (!outputFile) {
			const constructed = join(tasksDir, `${data.id}.jsonl`);
			// Confirm the session file is readable so the file-snapshot source
			// works later. The `exists` seam defaults to a readFile probe (pure);
			// callers may pass `fs.existsSync` to avoid reading the whole file.
			if (!exists(constructed)) continue; // session file doesn't exist — not navigable
			outputFile = constructed;
		}
		recovered.push({
			id: data.id,
			type: data.type,
			description: data.description,
			status: data.status,
			startedAt: data.startedAt,
			completedAt: data.completedAt,
			toolUses: data.toolUses ?? 0,
			modelName: data.modelName,
			thinking: data.thinking,
			outputFile,
		});
	}
	// Most-recent-first, matching listEvicted()'s ordering.
	recovered.sort((a, b) => b.startedAt - a.startedAt);
	return recovered;
}
