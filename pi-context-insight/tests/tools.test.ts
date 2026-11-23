import { describe, expect, it } from "vitest";
import { aggregateTools, collectToolExecutions } from "../src/activity/tools";
import { assistantEntry, resetEntryIds, toolCall, toolResultEntry } from "./helpers/entries";

const info = (name: string, over: Partial<{ path: string; source: string; scope: string; origin: string }> = {}) =>
	({
		name,
		description: "",
		parameters: {},
		exposure: "default",
		sourceInfo: { path: over.path ?? `builtin:${name}`, source: over.source ?? "", scope: over.scope ?? "user", origin: over.origin ?? "package" },
	}) as never;

describe("collectToolExecutions", () => {
	it("pairs calls with results and keeps durations", () => {
		resetEntryIds();
		const executions = collectToolExecutions({
			entries: [
				assistantEntry({ content: [toolCall("c1", "read", { path: "a" })], timestamp: 10 }),
				toolResultEntry({ toolCallId: "c1", toolName: "read", content: "x", durationMs: 40, timestamp: 50 }),
			],
		});
		expect(executions).toHaveLength(1);
		expect(executions[0]).toMatchObject({ name: "read", status: "ok", durationMs: 40, durationEstimated: false });
	});
	it("marks a call without a result as missing", () => {
		resetEntryIds();
		const executions = collectToolExecutions({
			entries: [assistantEntry({ content: [toolCall("c1", "read", { path: "a" })], timestamp: 10 })],
		});
		expect(executions[0]?.status).toBe("missing");
	});
	it("falls back to the call timestamp for durations", () => {
		resetEntryIds();
		const [execution] = collectToolExecutions({
			entries: [
				assistantEntry({ content: [toolCall("c1", "read", { path: "a" })], timestamp: 10 }),
				toolResultEntry({ toolCallId: "c1", toolName: "read", content: "x", timestamp: 60 }),
			],
		});
		expect(execution?.durationMs).toBe(50);
		expect(execution?.durationEstimated).toBe(true);
	});
	it("records nested calls as nested without charging their time twice", () => {
		resetEntryIds();
		const executions = collectToolExecutions({
			entries: [
				assistantEntry({ content: [toolCall("c1", "code", { code: "x" })], timestamp: 10 }),
				{
					...(toolResultEntry({ toolCallId: "c1", toolName: "code", content: "ok", durationMs: 500, timestamp: 510 }) as never),
				},
			],
		});
		expect(executions).toHaveLength(1);
		expect(executions[0]?.durationMs).toBe(500);
	});
});

describe("aggregateTools", () => {
	it("groups by name and maps the source scope", () => {
		resetEntryIds();
		const executions = collectToolExecutions({
			entries: [
				assistantEntry({ content: [toolCall("c1", "read", {}), toolCall("c2", "my_tool", {})], timestamp: 10 }),
				toolResultEntry({ toolCallId: "c1", toolName: "read", content: "x", timestamp: 20 }),
				toolResultEntry({ toolCallId: "c2", toolName: "my_tool", content: "x", isError: true, timestamp: 30 }),
			],
		});
		const rows = aggregateTools(executions, [
			info("read"),
			info("my_tool", { path: "/repo/.pi/tools/my.ts", scope: "project" }),
		]);
		expect(rows.find((row) => row.name === "read")?.source).toBe("builtin");
		expect(rows.find((row) => row.name === "my_tool")?.source).toBe("project");
		expect(rows.find((row) => row.name === "read")?.calls).toBe(1);
		expect(rows.find((row) => row.name === "my_tool")?.errors).toBe(1);
	});
	it("computes a per-step distribution", () => {
		resetEntryIds();
		const steps = [{ index: 0, timestamp: 10 }, { index: 1, timestamp: 100 }];
		const executions = collectToolExecutions({
			entries: [
				assistantEntry({ content: [toolCall("c1", "read", {})], timestamp: 10 }),
				toolResultEntry({ toolCallId: "c1", toolName: "read", content: "x", timestamp: 20 }),
				assistantEntry({ content: [toolCall("c2", "read", {})], timestamp: 100 }),
				toolResultEntry({ toolCallId: "c2", toolName: "read", content: "y", timestamp: 110 }),
			],
			steps,
		});
		const [row] = aggregateTools(executions, [info("read")]);
		expect(row?.perStep).toEqual([1, 1]);
		expect(row?.firstStep).toBe(0);
		expect(row?.lastStep).toBe(1);
	});
});
