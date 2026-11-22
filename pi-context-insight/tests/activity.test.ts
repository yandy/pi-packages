import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { analyzeActivity, analyzeTiming } from "../src/activity";

function assistant(id: string, calls: Array<Record<string, unknown>>, timestamp = 1_000, durationMs?: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: calls.map((call, index) => ({
				type: "toolCall",
				id: String(call.id ?? `${id}-call-${index}`),
				name: String(call.name),
				arguments: (call.arguments ?? {}) as Record<string, never>,
			})),
			api: "anthropic-messages",
			provider: "p",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp,
			...(durationMs === undefined ? {} : { durationMs }),
		},
	};
}

function result(
	id: string,
	toolCallId: string,
	toolName: string,
	options: {
		timestamp?: number;
		durationMs?: number;
		isError?: boolean;
		details?: Record<string, unknown>;
		nestedCalls?: Record<string, unknown>;
	} = {},
): SessionEntry {
	const timestamp = options.timestamp ?? 3_000;
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: "SENSITIVE OUTPUT" }],
			isError: options.isError ?? false,
			timestamp,
			...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
			...(options.details ? { details: options.details } : {}),
			...(options.nestedCalls ? { nestedCalls: options.nestedCalls } : {}),
		},
	} as SessionEntry;
}

describe("activity analysis", () => {
	it("pairs calls and results, preserves failures, and prefers exact durations", () => {
		const report = analyzeActivity([
			assistant("a1", [{ id: "exact", name: "read" }, { id: "fallback", name: "write" }, { id: "missing", name: "bash" }], 1_000),
			result("r1", "exact", "read", { timestamp: 2_500, durationMs: 123 }),
			result("r2", "fallback", "write", { timestamp: 4_000, isError: true }),
			result("r3", "orphan", "grep", { timestamp: 5_000, durationMs: 50 }),
		]);

		expect(report.executions).toEqual([
			{ id: "exact", name: "read", nested: false, status: "ok", timestamp: new Date(2_500).toISOString(), durationMs: 123, durationEstimated: false },
			{ id: "fallback", name: "write", nested: false, status: "error", timestamp: new Date(4_000).toISOString(), durationMs: 3_000, durationEstimated: true },
			{ id: "missing", name: "bash", nested: false, status: "missing", timestamp: new Date(1_000).toISOString(), durationMs: undefined, durationEstimated: false },
			{ id: "orphan", name: "grep", nested: false, status: "ok", timestamp: new Date(5_000).toISOString(), durationMs: 50, durationEstimated: false },
		]);
		expect(JSON.stringify(report)).not.toContain("SENSITIVE OUTPUT");
	});

	it("tracks nested calls separately and never retains their result bodies", () => {
		const report = analyzeActivity([
			assistant("a1", [{ id: "parent", name: "run_code", arguments: { secret: "do not copy" } }]),
			result("r1", "parent", "run_code", {
				nestedCalls: {
					complete: false,
					calls: [
						{ id: "nested-read", name: "read", arguments: { path: "nested.ts" }, status: "ok", durationMs: 50 },
						{ id: "nested-bash", name: "bash", arguments: { command: "echo nested" }, status: "unfinished" },
					],
				},
			}),
		]);

		const nestedRead = report.executions.find((execution) => execution.id === "parent/nested-read");
		const nestedBash = report.executions.find((execution) => execution.id === "parent/nested-bash");
		expect(nestedRead).toMatchObject({ name: "read", nested: true, status: "ok", durationMs: 50 });
		expect(nestedBash).toMatchObject({ name: "bash", nested: true, status: "unfinished" });
		expect(report.tools.filter((summary) => summary.nested)).toHaveLength(2);
		expect(report.files.find((file) => file.path === "nested.ts")?.read).toBe(1);
		expect(report.commands.find((command) => command.id === "parent/nested-bash")).toMatchObject({ nested: true, status: "missing", command: "echo nested" });
		expect(JSON.stringify(report)).not.toContain("SENSITIVE OUTPUT");
		expect(JSON.stringify(report)).not.toContain("do not copy");
	});

	it("aggregates file operations and estimates lines for modern and legacy edits", () => {
		const report = analyzeActivity([
			assistant("a1", [
				{ id: "read", name: "read", arguments: { path: "src/a.ts" } },
				{ id: "write", name: "write", arguments: { path: "src/b.ts", content: "one\ntwo\n" } },
				{ id: "edit", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "a\nb", newText: "a\nc\nd" }, { oldText: "x", newText: "" }] } },
				{ id: "legacy", name: "edit", arguments: { path: "legacy.ts", oldText: "a\r\nb", newText: "c\rd" } },
				{ id: "grep", name: "grep", arguments: { path: "src", pattern: "x" } },
				{ id: "find", name: "find", arguments: { path: "lib" } },
				{ id: "ls", name: "ls", arguments: {} },
				{ id: "ast", name: "ast_grep_search", arguments: { path: "patterns", pattern: "x" } },
				{ id: "unknown", name: "unknown", arguments: null },
			]),
		]);

		expect(report.files).toEqual([
			{ path: "src/a.ts", read: 1, written: 0, edited: 1, searched: 0, addedLines: 3, removedLines: 3 },
			{ path: "src/b.ts", read: 0, written: 1, edited: 0, searched: 0, addedLines: 2, removedLines: 0 },
			{ path: "legacy.ts", read: 0, written: 0, edited: 1, searched: 0, addedLines: 2, removedLines: 2 },
			{ path: "src", read: 0, written: 0, edited: 0, searched: 1, addedLines: 0, removedLines: 0 },
			{ path: "lib", read: 0, written: 0, edited: 0, searched: 1, addedLines: 0, removedLines: 0 },
			{ path: ".", read: 0, written: 0, edited: 0, searched: 1, addedLines: 0, removedLines: 0 },
			{ path: "patterns", read: 0, written: 0, edited: 0, searched: 1, addedLines: 0, removedLines: 0 },
		]);
		expect(report.tools.find((summary) => summary.name === "unknown")?.calls).toBe(1);
	});

	it("records command status without stdout or stderr", () => {
		const report = analyzeActivity([
			assistant("a1", [{ id: "bash", name: "bash", arguments: { command: "printf ok" } }, { id: "ps", name: "powershell", arguments: { command: "Get-Item ." } }, { id: "missing", name: "bash", arguments: { command: "echo missing" } }]),
			result("r1", "bash", "bash", { details: { exitCode: 0 }, durationMs: 20 }),
			result("r2", "ps", "powershell", { isError: true, details: { exitCode: 1 } }),
			{
				type: "message",
				id: "user-bash",
				parentId: null,
				timestamp: new Date(6_000).toISOString(),
				message: { role: "bashExecution", command: "echo user", output: "SECRET USER OUTPUT", exitCode: undefined, cancelled: true, truncated: false, timestamp: 6_000 },
			},
		]);

		expect(report.commands).toEqual([
			{ id: "bash", source: "bash", nested: false, command: "printf ok", status: "ok", timestamp: new Date(3_000).toISOString(), exitCode: 0, durationMs: 20, durationEstimated: false },
			{ id: "ps", source: "powershell", nested: false, command: "Get-Item .", status: "error", timestamp: new Date(3_000).toISOString(), exitCode: 1, durationMs: 2_000, durationEstimated: true },
			{ id: "missing", source: "bash", nested: false, command: "echo missing", status: "missing", timestamp: new Date(1_000).toISOString(), exitCode: undefined, durationMs: undefined, durationEstimated: false },
			{ id: "user-bash", source: "user-bash", nested: false, command: "echo user", status: "cancelled", timestamp: new Date(6_000).toISOString(), exitCode: undefined, durationMs: undefined, durationEstimated: false },
		]);
		expect(JSON.stringify(report)).not.toContain("SENSITIVE OUTPUT");
		expect(JSON.stringify(report)).not.toContain("SECRET USER OUTPUT");
	});

	it("keeps all calls in aggregates for long sessions", () => {
		const entries = Array.from({ length: 201 }, (_, index) => assistant(`a${index}`, [{ id: `call-${index}`, name: "read" }], index * 1_000));
		const report = analyzeActivity(entries);
		expect(report.executions).toHaveLength(201);
		expect(report.tools).toEqual([
			{ name: "read", nested: false, calls: 201, ok: 0, errors: 0, missing: 201, unfinished: 0, durationMs: 0, durationKnown: false, durationIncomplete: true },
		]);
	});
});

describe("timing analysis", () => {
	it("handles empty entries", () => {
		expect(analyzeTiming([], [])).toEqual({ wallTimeMs: 0, modelTimeMs: 0, toolTimeMs: 0, modelTimeIncomplete: false, toolTimeEstimated: false, toolTimeIncomplete: false });
	});

	it("separates wall, cumulative model and tool time", () => {
		const entries = [assistant("a1", [], 1_000, 100), assistant("a2", [], 6_000)];
		const executions = analyzeActivity([assistant("a3", [{ id: "exact", name: "read" }, { id: "fallback", name: "write" }], 1_000), result("r1", "exact", "read", { durationMs: 50 }), result("r2", "fallback", "write", { timestamp: 2_000 })]).executions;
		const timing = analyzeTiming(entries, executions);
		expect(timing).toEqual({
			startedAt: new Date(1_000).toISOString(),
			endedAt: new Date(6_000).toISOString(),
			wallTimeMs: 5_000,
			modelTimeMs: 100,
			toolTimeMs: 1_050,
			modelTimeIncomplete: true,
			toolTimeEstimated: true,
			toolTimeIncomplete: false,
		});
	});
});
