import { describe, expect, it, vi } from "vitest";
import type { EvictedSubagent } from "../../src/lifecycle/subagent-manager";
import { recoverEvictedSubagents } from "../../src/session/recover-subagents";

/**
 * Build a parent-session JSONL string from raw file entries (header + entries).
 * Each entry is stringified on its own line, as Pi persists them.
 */
function parentJsonl(entries: object[]): string {
	return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

const HEADER = { type: "session", version: 3, id: "parent-1", timestamp: "2026-06-23T00:00:00Z", cwd: "/proj" };

/** A `subagents:record` custom entry as persisted by onSubagentCompleted. */
function recordEntry(data: Record<string, unknown>): object {
	return {
		type: "custom",
		id: `e-${data.id ?? "x"}`,
		parentId: null,
		timestamp: "2026-06-23T00:00:10Z",
		customType: "subagents:record",
		data,
	};
}

describe("recoverEvictedSubagents", () => {
	it("returns subagent records persisted in the parent session file as evicted descriptors", () => {
		const jsonl = parentJsonl([
			HEADER,
			recordEntry({
				id: "a1",
				type: "general-purpose",
				description: "Investigate the bug",
				status: "completed",
				startedAt: 1000,
				completedAt: 4000,
				toolUses: 7,
				modelName: "haiku",
				thinking: "high",
				outputFile: "/tasks/a1.jsonl",
			}),
		]);
		const readFile = vi.fn(() => jsonl);

		const result = recoverEvictedSubagents("/parent.jsonl", readFile);

		expect(readFile).toHaveBeenCalledWith("/parent.jsonl");
		expect(result).toHaveLength(1);
		const [entry] = result;
		const expected: EvictedSubagent = {
			id: "a1",
			type: "general-purpose",
			description: "Investigate the bug",
			status: "completed",
			startedAt: 1000,
			completedAt: 4000,
			toolUses: 7,
			modelName: "haiku",
			thinking: "high",
			outputFile: "/tasks/a1.jsonl",
		};
		expect(entry).toEqual(expected);
	});

	it("orders records most-recent-first by startedAt", () => {
		const jsonl = parentJsonl([
			HEADER,
			recordEntry({ id: "old", startedAt: 1000, completedAt: 2000, outputFile: "/tasks/old.jsonl" }),
			recordEntry({ id: "new", startedAt: 5000, completedAt: 6000, outputFile: "/tasks/new.jsonl" }),
		]);

		const result = recoverEvictedSubagents("/parent.jsonl", () => jsonl);

		expect(result.map((r) => r.id)).toEqual(["new", "old"]);
	});

	it("skips records without an outputFile when the constructed session file does not exist", () => {
		const jsonl = parentJsonl([
			HEADER,
			recordEntry({ id: "no-file", startedAt: 1000, completedAt: 2000 }), // no outputFile
			recordEntry({ id: "with-file", startedAt: 1000, completedAt: 2000, outputFile: "/tasks/x.jsonl" }),
		]);

		// readFile only succeeds for the parent file; constructed paths fail.
		const readFile = vi.fn((path: string) => {
			if (path === "/parent.jsonl") return jsonl;
			throw new Error("ENOENT");
		});

		const result = recoverEvictedSubagents("/parent.jsonl", readFile);

		expect(result.map((r) => r.id)).toEqual(["with-file"]);
	});

	it("ignores non-subagent custom entries", () => {
		const jsonl = parentJsonl([
			HEADER,
			{ type: "custom", id: "c1", parentId: null, timestamp: "t", customType: "other:thing", data: {} },
			recordEntry({ id: "a1", startedAt: 1000, completedAt: 2000, outputFile: "/tasks/a1.jsonl" }),
		]);

		const result = recoverEvictedSubagents("/parent.jsonl", () => jsonl);

		expect(result.map((r) => r.id)).toEqual(["a1"]);
	});

	it("returns an empty list when the parent session file is not persisted", () => {
		const readFile = vi.fn();
		expect(recoverEvictedSubagents(undefined, readFile)).toEqual([]);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("returns an empty list when the file cannot be read", () => {
		const readFile = vi.fn(() => {
			throw new Error("ENOENT");
		});
		expect(recoverEvictedSubagents("/missing.jsonl", readFile)).toEqual([]);
	});

	it("tolerates records missing optional fields (modelName, toolUses)", () => {
		const jsonl = parentJsonl([
			HEADER,
			recordEntry({
				id: "a1",
				type: "Explore",
				description: "d",
				status: "completed",
				startedAt: 1,
				completedAt: 2,
				outputFile: "/tasks/a1.jsonl",
			}),
		]);

		const [entry] = recoverEvictedSubagents("/parent.jsonl", () => jsonl);

		expect(entry.modelName).toBeUndefined();
		expect(entry.toolUses).toBe(0);
		expect(entry.thinking).toBeUndefined();
	});

	it("recovers thinking from persisted records", () => {
		const jsonl = parentJsonl([
			HEADER,
			recordEntry({
				id: "a1",
				type: "Explore",
				description: "d",
				status: "completed",
				startedAt: 1000,
				completedAt: 4000,
				thinking: "off",
				outputFile: "/tasks/a1.jsonl",
			}),
		]);

		const [entry] = recoverEvictedSubagents("/parent.jsonl", () => jsonl);

		expect(entry.thinking).toBe("off");
	});

	it("constructs outputFile for old records that lack it, from the agent id and parent session directory", () => {
		const jsonl = parentJsonl([
			HEADER,
			// Old record (pre-fix): no outputFile
			recordEntry({
				id: "old-agent",
				type: "Explore",
				description: "pre-fix task",
				status: "completed",
				startedAt: 1000,
				completedAt: 4000,
				toolUses: 3,
			}),
		]);

		// readFile should be called for the constructed path to verify it exists.
		// The subagent session file is at <parent-dir>/<parent-basename>/tasks/<id>.jsonl
		const readFile = vi.fn((path: string) => {
			if (path === "/parent.jsonl") return jsonl;
			// Simulate the child session file existing
			if (path === "/parent/tasks/old-agent.jsonl") {
				return `${JSON.stringify({ type: "session", id: "old-agent", version: 3 })}\n`;
			}
			throw new Error("ENOENT");
		});

		const result = recoverEvictedSubagents("/parent.jsonl", readFile);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("old-agent");
		expect(result[0].outputFile).toBe("/parent/tasks/old-agent.jsonl");
	});
});
