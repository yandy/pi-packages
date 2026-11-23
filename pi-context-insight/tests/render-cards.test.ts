import { describe, expect, it } from "vitest";
import { CATEGORY_ORDER } from "../src/model";
import { renderCurrentContext } from "../src/render/context";
import { renderTimingCard } from "../src/render/timing";
import { renderTokens } from "../src/render/tokens";
import { buildReport } from "../src/report";
import { fakeContext } from "./helpers/ctx";
import { assistantEntry, resetEntryIds, systemEntry, usage, userEntry } from "./helpers/entries";

function report(over: { reserve?: number; enabled?: boolean; prompt?: number; longUser?: boolean; cache?: number } = {}) {
	resetEntryIds();
	const entries = [
		systemEntry({ sections: { preamble: "base", skills: "catalog" }, timestamp: 1 }),
		userEntry(over.longUser === true ? "long user message ".repeat(40) : "hello there", 2),
		assistantEntry({ content: [{ type: "text", text: "answer" }], usage: usage(over.prompt ?? 1000, 20, over.cache ?? 5000, 100, 0.2), durationMs: 500, timestamp: 3 }),
	];
	return buildReport(
		fakeContext(
			{ entries },
			{
				getSettings: () => ({ compaction: { enabled: over.enabled ?? true, reserveTokens: over.reserve ?? 16_384 } }),
				getContextUsage: () => ({ tokens: 12_345, contextWindow: 200_000, percent: 6.2 }),
			},
		),
		{ mode: "full", lang: "en" },
	);
}

describe("renderTokens", () => {
	it("lists categories in the canonical order", () => {
		const html = renderTokens(report());
		const order = [...html.matchAll(/data-cat="([^"]+)"/g)].map((match) => match[1]);
		const expected = CATEGORY_ORDER.filter((id) => id !== "unattributed");
		expect(order.slice(0, expected.length)).toEqual(expected);
	});
	it("marks estimates and the billed total", () => {
		const html = renderTokens(report());
		expect(html).toContain("≈");
		expect(html).toContain('data-billed="1"');
		expect(html).toContain("81.97%");
	});
	it("omits the unattributed row when the estimate covers the prompt", () => {
		const r = report({ prompt: 10, longUser: true, cache: 0 });
		expect(r.steps[0]?.sums.unattributed).toBe(0);
		expect(renderTokens(r)).not.toContain('data-cat="unattributed"');
	});
});

describe("renderTimingCard", () => {
	it("has model, tool and overhead segments only", () => {
		const html = renderTimingCard(report());
		const segments = [...html.matchAll(/data-timing-seg="([^"]+)"/g)].map((match) => match[1]);
		expect(segments).toEqual(["model", "tools", "other"]);
	});
	it("shows a tps badge", () => {
		expect(renderTimingCard(report())).toContain('data-tps="1"');
	});
});

describe("renderCurrentContext", () => {
	it("renders occupancy to one decimal", () => {
		expect(renderCurrentContext(report())).toContain("6.2%");
	});
	it("draws both reserve zones and the trigger line", () => {
		const html = renderCurrentContext(report());
		expect(html).toContain('data-reserve="headroom"');
		expect(html).toContain('data-reserve="output"');
		expect(html).toContain('data-trigger="1"');
	});
	it("explains when compaction is disabled", () => {
		const html = renderCurrentContext(report({ enabled: false }));
		expect(html).not.toContain('data-trigger="1"');
		expect(html).toContain("Automatic compaction is disabled");
	});
});
