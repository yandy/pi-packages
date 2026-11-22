import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { collectUsageLedger, summarizeUsage } from "../src/usage";

function makeUsage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number, fromProvider?: boolean): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: cost,
			...(fromProvider === undefined ? {} : { totalFromProvider: fromProvider }),
		},
	};
}

function assistant(id: string, usage: Usage, responseModel?: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "provider-a",
			model: "requested-model",
			...(responseModel ? { responseModel } : {}),
			usage,
			stopReason: "stop",
			timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
		},
	};
}

function usageEntry(id: string, kind: string, usage: Usage): SessionEntry {
	return {
		type: "usage",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:01:00.000Z",
		kind,
		provider: "provider-b",
		model: "aux-model",
		usage,
	};
}

function compaction(id: string, usage: Usage): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:02:00.000Z",
		summary: "summary",
		firstKeptEntryId: id,
		tokensBefore: 100,
		usage,
	};
}

describe("usage ledger", () => {
	it("collects assistant, auxiliary, summary and tool usage", () => {
		const entries: SessionEntry[] = [
			assistant("assistant-1", makeUsage(1, 2, 3, 4, 0.1), "physical-model"),
			usageEntry("usage-1", "cache_warm", makeUsage(5, 0, 6, 0, 0.2)),
			compaction("compaction-1", makeUsage(7, 1, 0, 0, 0.3)),
			{
				type: "branch_summary",
				id: "branch-1",
				parentId: null,
				timestamp: "2026-01-01T00:03:00.000Z",
				fromId: "assistant-1",
				summary: "branch",
				usage: makeUsage(8, 1, 0, 0, 0.4),
			},
			{
				type: "message",
				id: "tool-1",
				parentId: null,
				timestamp: "2026-01-01T00:04:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [],
					isError: false,
					timestamp: Date.parse("2026-01-01T00:04:00.000Z"),
					usage: makeUsage(9, 1, 0, 0, 0.5),
				},
			},
		];

		const ledger = collectUsageLedger(entries);
		expect(ledger.items.map((item) => item.source)).toEqual([
			"assistant",
			"cache_warm",
			"compaction",
			"branch_summary",
			"tool:read",
		]);
		expect(ledger.items[0]).toMatchObject({ provider: "provider-a", model: "physical-model" });
		expect(ledger.warnings).toEqual([]);
	});

	it("matches the parent direct/forwarded accounting boundary", () => {
		const ledger = collectUsageLedger([
			assistant("assistant-1", makeUsage(100, 20, 30, 10, 0.2)),
			usageEntry("subagent-1", "subagent", makeUsage(50, 5, 10, 0, 0.1)),
			compaction("compaction-1", makeUsage(10, 2, 0, 0, 0.03)),
		]);
		const report = summarizeUsage(ledger);

		expect(report.total).toMatchObject({ prompt: 210, output: 27, total: 237 });
		expect(report.total.cost).toBeCloseTo(0.33, 10);
		expect(report.total.cacheHitRate).toBeCloseTo(40 / 210, 10);
		expect(report.direct).toMatchObject({ prompt: 150, output: 22, total: 172 });
		expect(report.forwardedSubagents).toMatchObject({ prompt: 60, output: 5, total: 65 });
		expect(report.forwardedSubagents.cost).toBeCloseTo(0.1, 10);
	});

	it("groups physical models and tools/summaries without dropping auxiliary usage", () => {
		const report = summarizeUsage(
			collectUsageLedger([
				assistant("assistant-1", makeUsage(1, 1, 0, 0, 0.1), "physical-model"),
				usageEntry("usage-1", "cache_warm", makeUsage(2, 0, 0, 0, 0.2)),
				compaction("compaction-1", makeUsage(3, 1, 0, 0, 0.3)),
			]),
		);

		expect(report.byModel.map((entry) => entry.key)).toEqual([
			"provider-a/physical-model",
			"provider-b/aux-model",
			"Tools / summaries",
		]);
		expect(report.byModel[2].totals.total).toBe(4);
	});

	it("handles empty and mixed-cost inputs without NaN", () => {
		const empty = summarizeUsage({ items: [], warnings: [] });
		expect(empty.total).toMatchObject({ prompt: 0, total: 0, cost: 0, cacheHitRate: null, costBasis: "estimate" });
		expect(empty.byModel).toEqual([]);

		const mixed = summarizeUsage(
			collectUsageLedger([
				assistant("assistant-1", makeUsage(1, 1, 0, 0, 0.1, true)),
				assistant("assistant-2", makeUsage(1, 1, 0, 0, 0.1, false)),
			]),
		);
		expect(mixed.total.costBasis).toBe("mixed");
	});

	it("skips and reports malformed usage records instead of producing NaN", () => {
		const malformedAssistant = assistant("bad-assistant", makeUsage(1, 1, 0, 0, Number.NaN));
		const malformedUsage = usageEntry("bad-usage", makeUsage(1, 1, 0, 0, 0.1));
		delete (malformedUsage as { usage?: Usage }).usage;

		const ledger = collectUsageLedger([malformedAssistant, malformedUsage]);
		expect(ledger.items).toEqual([]);
		expect(ledger.warnings).toHaveLength(2);
		expect(ledger.warnings[0]).toContain("bad-assistant");
		expect(ledger.warnings[1]).toContain("bad-usage");
		expect(summarizeUsage(ledger).total.total).toBe(0);
	});
});
