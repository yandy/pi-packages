import { describe, expect, it } from "vitest";
import { buildSteps } from "../src/session/steps";
import {
	assistantEntry,
	branchSummaryEntry,
	compactionEntry,
	customMessageEntry,
	resetEntryIds,
	systemEntry,
	tool,
	toolCall,
	toolResultEntry,
	usage,
	userEntry,
} from "./helpers/entries";

const putBody = () => null;

describe("replay semantics", () => {
	it("counts custom messages and branch summaries as context", () => {
		resetEntryIds();
		const { steps } = buildSteps({
			branch: [
				userEntry("hi", 1),
				customMessageEntry("ext:note", "injected body", 2),
				branchSummaryEntry("branch body", "e0", 3),
				assistantEntry({ content: [{ type: "text", text: "x" }], timestamp: 4 }),
			],
			mode: "full",
			putBody,
		});
		expect(steps[0]?.sums.injected).toBeGreaterThan(0);
	});
	it("applies the compaction system snapshot", () => {
		resetEntryIds();
		const user = userEntry("hi", 1);
		const entries = [
			systemEntry({ sections: { preamble: "live", project_context: "AGENTS.md body" }, timestamp: 0 }),
			user,
			assistantEntry({ content: [{ type: "text", text: "a" }], timestamp: 2 }),
			compactionEntry({
				summary: "S",
				tokensBefore: 400,
				firstKeptEntryId: user.id,
				timestamp: 3,
				systemMessage: { role: "system", content: "", sections: { preamble: "snapshot" }, timestamp: 3 },
			}),
			assistantEntry({ content: [{ type: "text", text: "b" }], timestamp: 4 }),
		];
		const { steps } = buildSteps({ branch: entries, mode: "full", putBody });
		expect(steps[1]?.sums.systemProject).toBe(0);
		expect(steps[1]?.system?.sections.preamble).toBe("snapshot");
	});
	it("counts only the newest compaction summary", () => {
		resetEntryIds();
		const user = userEntry("hi", 1);
		const entries = [
			systemEntry({ sections: { preamble: "base" }, timestamp: 0 }),
			user,
			assistantEntry({ content: [{ type: "text", text: "a" }], timestamp: 2 }),
			compactionEntry({ summary: "A".repeat(400), tokensBefore: 300, firstKeptEntryId: user.id, timestamp: 3 }),
			assistantEntry({ content: [{ type: "text", text: "b" }], timestamp: 4 }),
			compactionEntry({ summary: "B".repeat(400), tokensBefore: 300, firstKeptEntryId: user.id, timestamp: 5 }),
			assistantEntry({ content: [{ type: "text", text: "c" }], timestamp: 6 }),
		];
		const { steps, items } = buildSteps({ branch: entries, mode: "full", putBody });
		const last = steps[2];
		const compactionItems = items.filter((item) => item.category === "compaction");
		expect(compactionItems).toHaveLength(2);
		expect(last?.sums.compaction).toBe(compactionItems[1]?.tokens);
	});
	it("drops a removed system section and removed tool declarations", () => {
		resetEntryIds();
		const entries = [
			systemEntry({ sections: { preamble: "base", skills: "catalog body" }, toolsAdded: [tool("read"), tool("web")], timestamp: 0 }),
			userEntry("hi", 1),
			systemEntry({ sections: { skills: null }, toolsRemoved: [{ name: "web" }], timestamp: 2 }),
			assistantEntry({ content: [{ type: "text", text: "a" }], timestamp: 3 }),
		];
		const { steps } = buildSteps({ branch: entries, mode: "full", putBody });
		expect(steps[0]?.sums.systemSkills).toBe(0);
		expect(steps[0]?.sums.toolDefinitions).toBeGreaterThan(0);
		const readOnly = buildSteps({
			branch: [systemEntry({ sections: { preamble: "base" }, toolsAdded: [tool("read")], timestamp: 0 }), entries[1]!, entries[3]!],
			mode: "full",
			putBody,
		});
		expect(steps[0]?.sums.toolDefinitions).toBe(readOnly.steps[0]?.sums.toolDefinitions);
	});
	it("commits the delta baseline only at request boundaries", () => {
		resetEntryIds();
		const entries = [
			systemEntry({ sections: { preamble: "base" }, timestamp: 0 }),
			userEntry("hi", 1),
			assistantEntry({ content: [toolCall("c1", "read", { path: "a" })], usage: usage(50, 5, 0, 0, 0), timestamp: 2 }),
			toolResultEntry({ toolCallId: "c1", toolName: "read", content: "tool body here", timestamp: 3 }),
			assistantEntry({ content: [{ type: "text", text: "done" }], usage: usage(60, 5, 0, 0, 0), timestamp: 4 }),
		];
		const { steps } = buildSteps({ branch: entries, mode: "full", putBody });
		expect(steps[1]?.delta.toolResults ?? 0).toBeGreaterThan(0);
		expect(steps[1]?.deltaTotal ?? 0).toBeGreaterThan(0);
		expect(steps[1]?.brief.inputs.length).toBeGreaterThan(0);
		const sum = Object.values(steps[1]?.delta ?? {}).reduce((a, b) => a + b, 0);
		expect(Math.abs(sum - (steps[1]?.deltaTotal ?? 0))).toBeLessThanOrEqual(1e-6);
	});
});
