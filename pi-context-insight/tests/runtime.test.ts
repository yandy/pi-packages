import { describe, expect, it } from "vitest";
import { CLIENT_RUNTIME } from "../src/client/runtime";

interface Runtime {
	visibleRows: (rows: Array<{ key: string; text: string }>, query: string) => string[];
	nextIndex: (current: number, delta: number, max: number) => number;
	resolveLang: (stored: string | null, initial: "en" | "zh") => "en" | "zh";
	buildTimeline: (steps: unknown, geo: unknown, opts: unknown) => {
		width: number;
		axisY: number;
		negative: boolean;
		bars: Array<{ segments: Array<{ id: string; y: number; h: number; negative: boolean }> }>;
		line: Array<[number, number]> | null;
	};
	turnBuckets: (steps: unknown) => Array<{ turn: number; sums: Record<string, number>; delta: Record<string, number>; total: number; count: number }>;
	groupLabelFor: (dicts: unknown, lang: string, group: string) => string;
	catLabelFor: (dicts: unknown, lang: string, cat: string) => string;
}

function load(): Runtime {
	return new Function("window", "document", `${CLIENT_RUNTIME}; return window.__insight;`)({}, undefined) as Runtime;
}

describe("client runtime", () => {
	it("boots without a document and exposes pure helpers", () => {
		expect(typeof load().visibleRows).toBe("function");
	});
	it("filters rows case-insensitively", () => {
		const rows = [
			{ key: "a", text: "Bash session" },
			{ key: "b", text: "read file" },
		];
		expect(load().visibleRows(rows, "ba")).toEqual(["a"]);
		expect(load().visibleRows(rows, "")).toEqual(["a", "b"]);
	});
	it("clamps navigation", () => {
		const { nextIndex } = load();
		expect(nextIndex(0, -1, 3)).toBe(0);
		expect(nextIndex(2, 1, 3)).toBe(2);
		expect(nextIndex(1, 1, 3)).toBe(2);
	});
	it("prefers a stored language and rejects unknown values", () => {
		expect(load().resolveLang("zh", "en")).toBe("zh");
		expect(load().resolveLang(null, "zh")).toBe("zh");
		expect(load().resolveLang("de", "en")).toBe("en");
	});
	it("contains no forbidden APIs", () => {
		for (const banned of ["innerHTML", "eval(", "new Function", "fetch(", "document.write"]) {
			expect(CLIENT_RUNTIME).not.toContain(banned);
		}
	});
});

describe("timeline geometry in the client", () => {
	const geo = { barW: 12, gap: 2, flagH: 26, chartH: 150, turnH: 24, height: 240, axisY: 176 };
	const step = (over: Record<string, unknown>) => ({
		i: 0,
		turn: 1,
		stepInTurn: 1,
		sums: {},
		delta: {},
		total: 0,
		durMs: 0,
		activeMs: 0,
		...over,
	});

	it("aggregates steps into turns using the sum of step deltas", () => {
		const buckets = load().turnBuckets([
			step({ i: 0, sums: { user: 10 }, delta: { user: 10 }, total: 10 }),
			step({ i: 1, sums: { user: 30 }, delta: { user: 20 }, total: 30 }),
			step({ i: 2, turn: 2, sums: { user: 40 }, delta: { user: 10 }, total: 40 }),
		] as never);
		expect(buckets).toHaveLength(2);
		expect(buckets[0].delta.user).toBe(30);
		expect(buckets[0].total).toBe(30);
		expect(buckets[0].count).toBe(2);
	});

	it("puts reclaimed context below the axis in delta mode", () => {
		const data = load().buildTimeline(
			[step({ delta: { user: -40 }, sums: { user: 10 }, total: 10 })] as never,
			geo as never,
			{ mode: "delta", granularity: "step", duration: false } as never,
		);
		expect(data.negative).toBe(true);
		expect(data.bars[0].segments[0].negative).toBe(true);
		expect(data.bars[0].segments[0].y).toBeGreaterThanOrEqual(geo.axisY);
	});

	it("stacks totals upward from the axis", () => {
		const data = load().buildTimeline(
			[step({ sums: { user: 50, answers: 50 }, total: 100 })] as never,
			geo as never,
			{ mode: "total", granularity: "step", duration: false } as never,
		);
		const segments = data.bars[0].segments;
		expect(segments).toHaveLength(2);
		expect(segments.every((segment: { negative: boolean }) => segment.negative === false)).toBe(true);
		expect(segments[1].y).toBe(geo.axisY - geo.chartH);
	});

	it("adds the duration polyline only when asked", () => {
		const steps = [step({ sums: { user: 10 }, total: 10, activeMs: 500 })] as never;
		expect(load().buildTimeline(steps, geo as never, { mode: "total", granularity: "step", duration: true } as never).line).not.toBeNull();
		expect(load().buildTimeline(steps, geo as never, { mode: "total", granularity: "step", duration: false } as never).line).toBeNull();
	});

	it("grows the canvas with the step count", () => {
		const many = Array.from({ length: 100 }, (_, index) => step({ i: index, sums: { user: 1 }, total: 1 })) as never;
		expect(load().buildTimeline(many, geo as never, { mode: "total", granularity: "step", duration: false } as never).width).toBeGreaterThan(1000);
	});
});

describe("client labels", () => {
	const dicts = { en: { "cat.toolDefinitions": "Tool schemas", "browser.system": "System prompt" }, zh: { "cat.toolDefinitions": "工具定义", "browser.system": "系统提示词" } };

	it("resolves group and category labels from the dictionary", () => {
		const runtime = load();
		expect(runtime.groupLabelFor(dicts as never, "zh", "toolDefinitions")).toBe("工具定义");
		expect(runtime.catLabelFor(dicts as never, "zh", "systemDocs")).toBe("系统提示词");
	});

	it("never returns an internal id when the dictionary has the key", () => {
		const runtime = load();
		for (const group of ["systemBase", "toolDefinitions", "toolCalls", "toolResults"]) {
			const label = runtime.groupLabelFor(dicts as never, "en", group);
			expect(label).not.toBe(group);
		}
	});
});
