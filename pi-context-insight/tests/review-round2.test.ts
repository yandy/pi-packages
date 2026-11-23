import { describe, expect, it } from "vitest";
import { buildSteps } from "../src/session/steps";
import { buildReport } from "../src/report";
import { renderTimeline } from "../src/render/timeline";
import { renderCurrentContext } from "../src/render/context";
import { computeTiming } from "../src/session/timing";
import { aggregateTools, collectToolExecutions } from "../src/activity/tools";
import { fakeContext } from "./helpers/ctx";
import {
	assistantEntry,
	compactionEntry,
	resetEntryIds,
	systemEntry,
	tool,
	toolCall,
	toolResultEntry,
	usage,
	userEntry,
} from "./helpers/entries";

const putBody = () => null;

describe("compaction system snapshots", () => {
	it("materialises the snapshot prompt and tools into the context", () => {
		resetEntryIds();
		const user = userEntry("hi", 1);
		const entries = [
			systemEntry({ sections: { preamble: "live prompt", project_context: "AGENTS" }, timestamp: 0 }),
			user,
			assistantEntry({ content: [{ type: "text", text: "a" }], timestamp: 2 }),
			compactionEntry({
				summary: "S",
				tokensBefore: 400,
				firstKeptEntryId: user.id,
				timestamp: 3,
				systemMessage: {
					role: "system",
					content: "",
					sections: { preamble: "snapshot prompt", tools: "tool index" },
					toolsAdded: [tool("read")],
					timestamp: 3,
				},
			}),
			assistantEntry({ content: [{ type: "text", text: "b" }], timestamp: 4 }),
		];
		const { steps, items } = buildSteps({ branch: entries, mode: "full", putBody });
		const after = steps[1];
		expect(after?.sums.systemBase).toBeGreaterThan(0);
		expect(after?.sums.systemTools).toBeGreaterThan(0);
		expect(after?.sums.toolDefinitions).toBeGreaterThan(0);
		expect(after?.sums.systemProject).toBe(0);
		expect(items.some((item) => item.kind === "toolDefinition" && item.tag === "read")).toBe(true);
	});
	it("keeps the full accumulated base prompt as one item", () => {
		resetEntryIds();
		const entries = [
			systemEntry({ content: "part one", timestamp: 0 }),
			systemEntry({ content: " and part two", timestamp: 1 }),
			userEntry("hi", 2),
			assistantEntry({ content: [{ type: "text", text: "a" }], timestamp: 3 }),
		];
		const { steps, items } = buildSteps({ branch: entries, mode: "full", putBody });
		const baseItems = items.filter((item) => item.kind === "systemSection" && item.tag === "base");
		expect(baseItems.length).toBeGreaterThan(0);
		const last = baseItems[baseItems.length - 1];
		expect(last?.tokens).toBeGreaterThan(baseItems[0]?.tokens ?? 0);
		expect(steps[0]?.system?.base).toBe("part one and part two");
		expect(steps[0]?.sums.systemBase).toBe(last?.tokens ?? -1);
	});
});

describe("delta and current context", () => {
	it("keeps deltaTotal equal to the estimate difference", () => {
		resetEntryIds();
		const entries = [
			userEntry("hi", 1),
			assistantEntry({ content: [{ type: "text", text: "a" }], usage: usage(2000, 10, 0, 0, 0.1), timestamp: 2 }),
			userEntry("again", 3),
			assistantEntry({ content: [{ type: "text", text: "b" }], usage: usage(10, 10, 0, 0, 0.1), timestamp: 4 }),
		];
		const { steps } = buildSteps({ branch: entries, mode: "full", putBody });
		expect(steps[1]?.deltaTotal).toBe((steps[1]?.estimatedTotal ?? 0) - (steps[0]?.estimatedTotal ?? 0));
	});
	it("does not spread post-request growth across every category", () => {
		resetEntryIds();
		const entries = [
			userEntry("hi", 1),
			assistantEntry({ content: [{ type: "text", text: "answer body ".repeat(80) }], usage: usage(50, 10, 0, 0, 0.1), timestamp: 2 }),
		];
		const report = buildReport(fakeContext({ entries }), { mode: "full", lang: "en" });
		const categories = report.currentContext.categories;
		expect(categories.answers).toBeGreaterThan(0);
		expect(categories.user ?? 0).toBeLessThan(categories.answers);
		expect(categories.reasoning ?? 0).toBe(0);
	});
});

describe("abnormal inputs", () => {
	it("rejects non-finite model durations", () => {
		const timing = computeTiming({
			entries: [
				userEntry("a", 0),
				assistantEntry({ content: [], durationMs: Number.NaN, timestamp: 1000 }),
			],
			steps: [],
			executions: [],
		});
		expect(Number.isFinite(timing.modelMs)).toBe(true);
		expect(timing.modelMs).toBe(0);
	});
	it("keeps timeline geometry inside the viewBox after capping", () => {
		const base = buildReport(fakeContext({ entries: [userEntry("hi", 1)] }), { mode: "full", lang: "en" });
		resetEntryIds();
		const seeded = buildReport(
			fakeContext({ entries: [userEntry("hi", 1), assistantEntry({ content: [{ type: "text", text: "x" }], timestamp: 2 })] }),
			{ mode: "full", lang: "en" },
		);
		const steps = Array.from({ length: 4005 }, (_, index) => ({
			...seeded.steps[0]!,
			index,
			stepInTurn: index + 1,
			estimatedTotal: 10 + index,
			timestamp: index,
		}));
		const html = renderTimeline({ ...base, steps, turns: [] });
		const xs = [...html.matchAll(/data-step="\d+"/g)];
		expect(xs.length).toBe(4000);
		expect(html).not.toMatch(/x="1[0-9]{5,}"/);
		expect(html).toContain('data-timeline-cap="4000"');
	});
	it("sanitises context geometry", () => {
		const report = buildReport(fakeContext({ entries: [userEntry("hi", 1)] }), { mode: "full", lang: "en" });
		const weird = {
			...report,
			currentContext: {
				...report.currentContext,
				categories: { ...report.currentContext.categories, user: Number.NaN, answers: Number.POSITIVE_INFINITY },
				reserveTokens: Number.NaN,
				maxTokens: Number.POSITIVE_INFINITY,
			},
		};
		const html = renderCurrentContext(weird);
		expect(html).not.toMatch(/NaN|Infinity/);
	});
});

describe("tool and family edges", () => {
	it("keeps nested calls of an orphan result", () => {
		resetEntryIds();
		const orphan = toolResultEntry({ toolCallId: "ghost", toolName: "code", content: "ok", timestamp: 5 });
		(orphan as never as { message: { nestedCalls: unknown } }).message.nestedCalls = {
			calls: [{ id: "n1", name: "bash", arguments: { command: "ls" }, status: "ok", durationMs: 5 }],
			complete: true,
		};
		const executions = collectToolExecutions({ entries: [orphan] });
		expect(executions.some((execution) => execution.name === "bash" && execution.nested)).toBe(true);
		expect(executions.some((execution) => execution.name === "code")).toBe(false);
		const rows = aggregateTools(executions, []);
		expect(rows.map((row) => row.name)).toEqual(["bash"]);
	});
});
