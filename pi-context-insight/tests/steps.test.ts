import { describe, expect, it } from "vitest";
import { buildSteps } from "../src/session/steps";
import {
	assistantEntry,
	compactionEntry,
	contextEditEntry,
	resetEntryIds,
	systemEntry,
	tool,
	toolCall,
	toolResultEntry,
	usage,
	userEntry,
} from "./helpers/entries";

const putBody = () => null;

function stepCountFixture(): Parameters<typeof buildSteps>[0]["branch"] {
	resetEntryIds();
	return [
		systemEntry({ sections: { preamble: "base" }, toolsAdded: [tool("read")], timestamp: 1 }),
		userEntry("hi", 2),
		assistantEntry({ content: [{ type: "text", text: "a1" }], usage: usage(100, 10, 0, 0, 0.1), timestamp: 3 }),
		userEntry("again", 4),
		assistantEntry({ content: [{ type: "text", text: "a2" }], usage: usage(120, 10, 0, 0, 0.1), timestamp: 5 }),
		assistantEntry({ content: [{ type: "text", text: "a3" }], usage: usage(140, 10, 0, 0, 0.1), timestamp: 6 }),
	];
}

describe("buildSteps", () => {
	it("resets at a compaction and keeps post-compaction sums exact", () => {
		resetEntryIds();
		const system = systemEntry({ sections: { preamble: "base" }, toolsAdded: [tool("read")], timestamp: 1 });
		const user = userEntry("hi", 2);
		const kept = assistantEntry({ content: [{ type: "text", text: "kept" }], usage: usage(100, 10, 0, 0, 0.1), timestamp: 3 });
		const entries = [
			system,
			user,
			kept,
			compactionEntry({ summary: "S", tokensBefore: 500, firstKeptEntryId: user.id, timestamp: 4 }),
			assistantEntry({ content: [{ type: "text", text: "after" }], usage: usage(90, 5, 0, 0, 0.1), timestamp: 5 }),
		];
		const { steps } = buildSteps({ branch: entries, mode: "full", putBody });
		expect(steps).toHaveLength(2);
		expect(steps[1]?.sums.compaction).toBeGreaterThan(0);
		expect(steps[1]?.sums.toolDefinitions).toBe(0);
	});
	it("handles two compactions where firstKeptEntryId lies in an earlier kept range", () => {
		resetEntryIds();
		const user = userEntry("hi", 2);
		const entries = [
			systemEntry({ sections: { preamble: "base" }, timestamp: 1 }),
			user,
			assistantEntry({ content: [{ type: "text", text: "s1" }], usage: usage(100, 10, 0, 0, 0.1), timestamp: 3 }),
			compactionEntry({ summary: "A", tokensBefore: 500, firstKeptEntryId: user.id, timestamp: 4 }),
			assistantEntry({ content: [{ type: "text", text: "s2" }], usage: usage(100, 10, 0, 0, 0.1), timestamp: 5 }),
			compactionEntry({ summary: "B", tokensBefore: 400, firstKeptEntryId: user.id, timestamp: 6 }),
			assistantEntry({ content: [{ type: "text", text: "s3" }], usage: usage(100, 10, 0, 0, 0.1), timestamp: 7 }),
		];
		const { steps, items } = buildSteps({ branch: entries, mode: "full", putBody });
		expect(steps).toHaveLength(3);
		expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
		expect(steps[2]?.sums.user).toBeGreaterThan(0);
	});
	it("drops a context-edited item from later steps only", () => {
		resetEntryIds();
		const entries = [
			systemEntry({ sections: { preamble: "base" }, timestamp: 1 }),
			userEntry("hi", 2),
			assistantEntry({ content: [toolCall("c1", "read", { path: "a" })], usage: usage(50, 5, 0, 0, 0.1), timestamp: 3 }),
			toolResultEntry({ toolCallId: "c1", toolName: "read", content: "file body", timestamp: 4 }),
			assistantEntry({ content: [toolCall("c2", "read", { path: "b" })], usage: usage(60, 5, 0, 0, 0.1), timestamp: 5 }),
			contextEditEntry("", null, 6),
			assistantEntry({ content: [{ type: "text", text: "done" }], usage: usage(70, 5, 0, 0, 0.1), timestamp: 7 }),
		];
		entries[5] = contextEditEntry(entries[3]!.id, null, 6);
		const { steps } = buildSteps({ branch: entries, mode: "full", putBody });
		expect(steps).toHaveLength(3);
		expect(steps[1]?.sums.toolResults).toBeGreaterThan(0);
		expect(steps[2]?.sums.toolResults).toBe(0);
		expect(steps[2]?.delta.toolResults).toBeLessThan(0);
	});
	it("does not throw on a tool call without a result", () => {
		resetEntryIds();
		const { steps, items } = buildSteps({
			branch: [
				userEntry("hi", 1),
				assistantEntry({ content: [toolCall("c1", "read", { path: "a" })], usage: usage(10, 5, 0, 0, 0), timestamp: 2 }),
			],
			mode: "full",
			putBody,
		});
		expect(steps).toHaveLength(1);
		expect(items.filter((i) => i.category === "toolCalls")).toHaveLength(1);
	});
	it("records no actual usage on sessions without usage entries", () => {
		resetEntryIds();
		const { steps } = buildSteps({
			branch: [userEntry("hi", 1), assistantEntry({ content: [{ type: "text", text: "x" }], timestamp: 2 })],
			mode: "full",
			putBody,
		});
		expect(steps[0]?.actual).toBeUndefined();
	});
	it("assigns turns and step-in-turn numbers", () => {
		const { steps } = buildSteps({ branch: stepCountFixture(), mode: "full", putBody });
		expect(steps.map((s) => [s.turn, s.stepInTurn])).toEqual([
			[1, 1],
			[2, 1],
			[2, 2],
		]);
	});
	it("records unattributed only above two percent of the estimate", () => {
		resetEntryIds();
		const entries = [
			userEntry("hi", 1),
			assistantEntry({ content: [{ type: "text", text: "x" }], usage: usage(2000, 10, 0, 0, 0.1), timestamp: 2 }),
			userEntry("big user message ".repeat(40), 3),
			assistantEntry({ content: [{ type: "text", text: "y" }], usage: usage(10, 10, 0, 0, 0.1), timestamp: 4 }),
		];
		const { steps } = buildSteps({ branch: entries, mode: "full", putBody });
		expect(steps[0]?.sums.unattributed).toBeGreaterThan(0);
		expect(steps[1]?.sums.unattributed).toBe(0);
	});
	it("marks steps outside the detail window as summary-only", () => {
		resetEntryIds();
		const branch: Parameters<typeof buildSteps>[0]["branch"] = [systemEntry({ sections: { preamble: "b" }, timestamp: 0 })];
		let t = 1;
		for (let i = 0; i < 305; i++) {
			branch.push(userEntry(`q${i}`, t++));
			branch.push(assistantEntry({ content: [{ type: "text", text: `a${i}` }], timestamp: t++ }));
		}
		const { steps } = buildSteps({ branch, mode: "full", putBody });
		expect(steps).toHaveLength(305);
		expect(steps[0]?.hasDetails).toBe(false);
		expect(steps.at(-1)?.hasDetails).toBe(true);
	});
});
