import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stepIndexOf } from "../session/steps";

export type FileOpKind = "read" | "write" | "search" | "image";

export interface FileOp {
	id: string;
	path: string;
	kind: FileOpKind;
	tool: string;
	timestamp: number;
	stepIndex: number;
	added: number;
	removed: number;
	hits?: number;
	readRange?: { start: number; count: number; estimated: boolean };
	isError: boolean;
	toolCallId?: string;
	patternOnly?: boolean;
}

export interface FileRow {
	path: string;
	displayName: string;
	directory: string;
	counts: Record<FileOpKind, number>;
	added: number;
	removed: number;
	lastTimestamp: number;
	ops: FileOp[];
}

export type FileSort = "count" | "lines" | "latest" | "path" | "name";

interface CallInfo {
	name: string;
	arguments: Record<string, unknown>;
	timestamp: number;
}

const READ_TOOLS = new Set(["read", "read_image"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const SEARCH_TOOLS = new Set(["grep", "find", "ls", "ast_grep_search"]);

function countLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split(/\r\n|\r|\n/);
	if (/(?:\r\n|\r|\n)$/.test(text)) lines.pop();
	return lines.length;
}

function pathOf(args: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path", "filePath"]) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (typeof block === "object" && block !== null && "text" in block ? String(block.text ?? "") : ""))
		.join("\n");
}

function hasImage(content: unknown): boolean {
	return Array.isArray(content) && content.some((block) => (block as { type?: unknown }).type === "image");
}

const GREP_LINE = /^(.+?):(\d+):(.*)$/;

function searchOps(args: {
	id: string;
	call: CallInfo;
	result?: { content: unknown; isError: boolean; timestamp: number };
	timestamp: number;
	stepIndex: number;
}): Array<Omit<FileOp, "stepIndex">> {
	const { id, call, result, timestamp } = args;
	const target = pathOf(call.arguments);
	const base = {
		tool: call.name,
		timestamp,
		added: 0,
		removed: 0,
		isError: result?.isError ?? false,
		toolCallId: id,
	};
	if (result === undefined) return [];
	const text = textOf(result.content);

	if (call.name === "grep" || call.name === "ast_grep_search") {
		const hits = new Map<string, number>();
		for (const line of text.split(/\r?\n/)) {
			const match = GREP_LINE.exec(line);
			if (match === null) continue;
			const path = match[1] ?? "";
			if (path.length === 0 || path.startsWith("[")) continue;
			hits.set(path, (hits.get(path) ?? 0) + 1);
		}
		if (hits.size > 0) {
			return [...hits].map(([path, count]) => ({
				...base,
				id: `${id}:${path}`,
				path,
				kind: "search" as const,
				hits: count,
			}));
		}
		const fallback = target ?? ".";
		return [{ ...base, id, path: fallback, kind: "search", patternOnly: true }];
	}

	const paths = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("[")) continue;
		paths.add(trimmed);
	}
	if (call.name === "find" && paths.size > 0) {
		return [...paths].map((path) => ({ ...base, id: `${id}:${path}`, path, kind: "search" as const, hits: 0 }));
	}
	return [{ ...base, id, path: target ?? ".", kind: "search", hits: 0 }];
}

/** Every file operation the session recorded, in transcript order. */
export function collectFileOps(args: {
	entries: readonly SessionEntry[];
	steps?: ReadonlyArray<{ index: number; timestamp: number }>;
}): FileOp[] {
	const { entries, steps = [] } = args;
	const calls = new Map<string, CallInfo>();
	const ops: FileOp[] = [];
	const push = (op: Omit<FileOp, "stepIndex">, timestamp: number): void => {
		ops.push({ ...op, stepIndex: stepIndexOf(timestamp, steps) });
	};

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of (message.content ?? []) as Array<{
				type?: unknown;
				id?: unknown;
				name?: unknown;
				arguments?: unknown;
			}>) {
				if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
				calls.set(block.id, {
					name: block.name,
					arguments: (block.arguments as Record<string, unknown>) ?? {},
					timestamp: message.timestamp,
				});
			}
			continue;
		}
		if (message.role === "user" && hasImage(message.content)) {
			const timestamp = message.timestamp;
			push(
				{
					id: `user-image:${entry.id}`,
					path: "(message image)",
					kind: "image",
					tool: "user",
					timestamp,
					added: 0,
					removed: 0,
					isError: false,
				},
				timestamp,
			);
			continue;
		}
		if (message.role !== "toolResult") continue;

		const call = calls.get(message.toolCallId);
		if (call === undefined) continue;
		const timestamp = message.timestamp;
		const category = READ_TOOLS.has(call.name)
			? "read"
			: WRITE_TOOLS.has(call.name)
				? "write"
				: SEARCH_TOOLS.has(call.name)
					? "search"
					: undefined;
		if (category === undefined) continue;
		const path = pathOf(call.arguments);

		if (category === "search") {
			for (const op of searchOps({
				id: message.toolCallId,
				call,
				result: { content: message.content, isError: message.isError, timestamp },
				timestamp,
				stepIndex: 0,
			})) {
				push(op, timestamp);
			}
			continue;
		}

		if (path === undefined) continue;

		if (hasImage(message.content) && category === "read") {
			push(
				{
					id: message.toolCallId,
					path,
					kind: "image",
					tool: call.name,
					timestamp,
					added: 0,
					removed: 0,
					isError: message.isError,
					toolCallId: message.toolCallId,
				},
				timestamp,
			);
		}

		if (category === "read") {
			const offset = typeof call.arguments.offset === "number" ? call.arguments.offset : 1;
			const limit = typeof call.arguments.limit === "number" ? call.arguments.limit : countLines(textOf(message.content));
			push(
				{
					id: message.toolCallId,
					path,
					kind: "read",
					tool: call.name,
					timestamp,
					added: 0,
					removed: 0,
					isError: message.isError,
					toolCallId: message.toolCallId,
					readRange: { start: offset, count: limit, estimated: typeof call.arguments.limit === "number" },
				},
				timestamp,
			);
			continue;
		}

		let added = 0;
		let removed = 0;
		if (call.name === "write" && typeof call.arguments.content === "string") {
			added = countLines(call.arguments.content);
		} else if (call.name === "edit") {
			const edits = Array.isArray(call.arguments.edits) ? call.arguments.edits : [call.arguments];
			for (const raw of edits) {
				const edit = (raw ?? {}) as Record<string, unknown>;
				if (typeof edit.newText === "string") added += countLines(edit.newText);
				if (typeof edit.oldText === "string") removed += countLines(edit.oldText);
			}
		}
		push(
			{
				id: message.toolCallId,
				path,
				kind: "write",
				tool: call.name,
				timestamp,
				added,
				removed,
				isError: message.isError,
				toolCallId: message.toolCallId,
			},
			timestamp,
		);
	}

	return ops;
}

function splitPath(path: string): { directory: string; displayName: string } {
	const normalized = path.replace(/\\/g, "/");
	const index = normalized.lastIndexOf("/");
	if (index < 0) return { directory: "", displayName: normalized };
	return { directory: normalized.slice(0, index + 1), displayName: normalized.slice(index + 1) };
}

/** One row per path, with the operations newest first. */
export function aggregateFiles(ops: readonly FileOp[], sort: FileSort = "lines"): FileRow[] {
	const rows = new Map<string, FileRow>();
	for (const op of ops) {
		let row = rows.get(op.path);
		if (row === undefined) {
			const { directory, displayName } = splitPath(op.path);
			row = {
				path: op.path,
				displayName,
				directory,
				counts: { read: 0, write: 0, search: 0, image: 0 },
				added: 0,
				removed: 0,
				lastTimestamp: op.timestamp,
				ops: [],
			};
			rows.set(op.path, row);
		}
		row.counts[op.kind] += 1;
		row.added += op.added;
		row.removed += op.removed;
		row.lastTimestamp = Math.max(row.lastTimestamp, op.timestamp);
		row.ops.push(op);
	}

	const list = [...rows.values()];
	for (const row of list) row.ops.sort((a, b) => b.timestamp - a.timestamp);

	const totalOps = (row: FileRow) => row.ops.length;
	list.sort((a, b) => {
		switch (sort) {
			case "count":
				return totalOps(b) - totalOps(a) || a.path.localeCompare(b.path);
			case "latest":
				return b.lastTimestamp - a.lastTimestamp || a.path.localeCompare(b.path);
			case "path":
				return a.path.localeCompare(b.path);
			case "name":
				return a.displayName.localeCompare(b.displayName) || a.path.localeCompare(b.path);
			default:
				return b.added + b.removed - (a.added + a.removed) || totalOps(b) - totalOps(a);
		}
	});
	return list;
}
