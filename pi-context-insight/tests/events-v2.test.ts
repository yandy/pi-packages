import { describe, expect, it } from "vitest";
import { buildMilestones, collectEvents } from "../src/session/events";
import type { Step } from "../src/session/steps";
import {
	assistantEntry,
	branchSummaryEntry,
	compactionEntry,
	contextEditEntry,
	customMessageEntry,
	modelChangeEntry,
	resetEntryIds,
	thinkingChangeEntry,
	toolCall,
	toolResultEntry,
	userEntry,
} from "./helpers/entries";

function step(index: number, timestamp: number, estimatedTotal: number, activeMs = 1000): Step {
	return {
		index,
		turn: 1,
		stepInTurn: index + 1,
		timestamp,
		durationMs: activeMs,
		durationEstimated: false,
		activeMs,
		idleMs: 0,
		sums: {} as never,
		estimatedTotal,
		delta: {},
		deltaTotal: 0,
		itemRanges: [],
		eventIds: [],
		hasDetails: true,
		brief: { inputs: [], replies: [] },
		system: null,
	};
}

describe("collectEvents", () => {
	it("marks compaction with its net token change", () => {
		resetEntryIds();
		const entries = [
			userEntry("hi", 10),
			compactionEntry({ summary: "S", tokensBefore: 500, firstKeptEntryId: "e1", timestamp: 20 }),
			assistantEntry({ content: [], timestamp: 30 }),
		];
		const events = collectEvents({ entries, steps: [step(0, 30, 200)], subagentRecords: [] });
		const compaction = events.find((event) => event.kind === "compaction");
		expect(compaction?.text.key).toBe("event.compaction");
		expect(compaction?.grossTokens).toBe(500);
		expect(compaction?.tokens).toBe(-300);
	});
	it("marks context edits as removal", () => {
		resetEntryIds();
		const entries = [userEntry("hi", 10), contextEditEntry("e1", null, 20), assistantEntry({ content: [], timestamp: 30 })];
		const events = collectEvents({ entries, steps: [step(0, 30, 0)], subagentRecords: [] });
		expect(events[0]?.text.key).toBe("event.contextEditRemove");
	});
	it("marks branch summaries, model and thinking switches", () => {
		resetEntryIds();
		const entries = [
			userEntry("hi", 10),
			branchSummaryEntry("s", "e0", 15),
			modelChangeEntry("anthropic", "claude", 20),
			thinkingChangeEntry("high", 25),
		];
		const events = collectEvents({ entries, steps: [step(0, 30, 0)], subagentRecords: [] });
		expect(events.map((event) => event.text.key)).toEqual([
			"event.branchSummary",
			"event.model",
			"event.thinking",
		]);
		expect(events[1]?.text.params?.to).toBe("anthropic/claude");
	});
	it("marks skill loads and injections", () => {
		resetEntryIds();
		const entries = [
			assistantEntry({ content: [toolCall("c1", "read", { path: "/repo/skills/pdf/SKILL.md" })], timestamp: 10 }),
			toolResultEntry({ toolCallId: "c1", toolName: "read", content: "body", timestamp: 20 }),
			customMessageEntry("ext:note", "x", 25),
		];
		const events = collectEvents({ entries, steps: [step(0, 30, 0)], subagentRecords: [] });
		expect(events.map((event) => event.text.key)).toEqual(["event.skill", "event.inject"]);
		expect(events[0]?.text.params?.name).toBe("pdf");
	});
	it("marks delegation and completion from subagent records", () => {
		resetEntryIds();
		const events = collectEvents({
			entries: [userEntry("hi", 10)],
			steps: [step(0, 30, 0)],
			subagentRecords: [{ id: "a1", description: "audit", status: "completed", startedAt: 15, completedAt: 25 }],
		});
		expect(events.map((event) => event.text.key)).toEqual(["event.delegate", "event.childDone"]);
	});
	it("marks asks and todo changes from tool calls", () => {
		resetEntryIds();
		const entries = [
			assistantEntry({ content: [toolCall("c1", "ask_user", { question: "which?" })], timestamp: 10 }),
			toolResultEntry({ toolCallId: "c1", toolName: "ask_user", content: "a", timestamp: 20 }),
			assistantEntry({ content: [toolCall("c2", "todo", { action: "set", items: [{}, {}, {}] })], timestamp: 30 }),
		];
		const events = collectEvents({ entries, steps: [step(0, 30, 0)], subagentRecords: [] });
		expect(events.map((event) => [event.text.key, event.text.params?.count])).toEqual([
			["event.ask", 1],
			["event.todoAdd", 3],
		]);
	});
});

describe("buildMilestones", () => {
	it("merges events that land on the same step", () => {
		const steps = [step(0, 100, 10), step(1, 200, 20)];
		const events = [
			{ id: 0, kind: "compaction" as const, timestamp: 150, stepIndex: 1, text: { key: "event.compaction" } },
			{ id: 1, kind: "model" as const, timestamp: 160, stepIndex: 1, text: { key: "event.model" } },
		];
		const { milestones } = buildMilestones(events, steps);
		const merged = milestones.filter((milestone) => milestone.eventIds.length > 0);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.eventIds).toEqual([0, 1]);
		expect(milestones.filter((milestone) => milestone.kind === "longest")).toHaveLength(1);
	});
	it("marks the single longest and biggest-growth step", () => {
		const steps = [step(0, 100, 10, 500), step(1, 200, 900, 9000), step(2, 300, 950, 4000)];
		steps[1]!.deltaTotal = 890;
		steps[2]!.deltaTotal = 50;
		const { peaks } = buildMilestones([], steps);
		expect(peaks.longest).toBe(1);
		expect(peaks.growth).toBe(1);
	});
});
