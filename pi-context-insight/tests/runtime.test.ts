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
		marker: [number, number] | null;
		max: number;
		flags: Array<{ step: number; kind: string; count: number }>;
		turns: Array<{ index: number; width: number }>;
		labels: Array<{ text: string }>;
	};
	timelineGeometry: (count: number) => { barW: number; gap: number; axisY: number; height: number };
	turnBuckets: (steps: unknown) => Array<{ turn: number; sums: Record<string, number>; delta: Record<string, number>; total: number; count: number }>;
	groupLabelFor: (dicts: unknown, lang: string, group: string) => string;
	catLabelFor: (dicts: unknown, lang: string, cat: string) => string;
	applyLanguageFromDoc: (doc: unknown, lang: string, dicts: unknown, meta?: unknown) => void;
	highlightRailFromDoc: (doc: unknown, activeId: string) => void;
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

	it("adds the duration line only when asked", () => {
		const steps = [
			step({ i: 0, sums: { user: 10 }, total: 10, activeMs: 500 }),
			step({ i: 1, sums: { user: 20 }, total: 20, activeMs: 900 }),
		] as never;
		expect(load().buildTimeline(steps, geo as never, { mode: "total", granularity: "step", duration: true } as never).line).toHaveLength(2);
		expect(load().buildTimeline(steps, geo as never, { mode: "total", granularity: "step", duration: false } as never).line).toBeNull();
	});

	it("draws a marker instead of a one-point line", () => {
		const data = load().buildTimeline([step({ sums: { user: 10 }, total: 10, activeMs: 500 })] as never, geo as never, {
			mode: "total",
			granularity: "step",
			duration: true,
		} as never);
		expect(data.line).toBeNull();
		expect(data.marker).not.toBeNull();
	});

	it("keeps negative bars inside the chart box", () => {
		const data = load().buildTimeline(
			[step({ delta: { user: -1000 }, sums: { user: 10 }, total: 10 })] as never,
			geo as never,
			{ mode: "delta", granularity: "step", duration: false } as never,
		);
		const segment = data.bars[0].segments[0];
		expect(segment.y + segment.h).toBeLessThanOrEqual(geo.height - geo.turnH);
	});

	it("scales the axis to the delta range, not the cumulative total", () => {
		const data = load().buildTimeline([step({ delta: { user: -900 }, sums: { user: 5000 }, total: 5000 })] as never, geo as never, {
			mode: "delta",
			granularity: "step",
			duration: false,
		} as never);
		expect(data.max).toBe(900);
	});

	it("jumps a turn bar to the turn's last step", () => {
		const data = load().buildTimeline(
			[
				step({ i: 0, turn: 1, sums: { user: 1 }, total: 1 }),
				step({ i: 1, turn: 1, sums: { user: 2 }, total: 2 }),
				step({ i: 2, turn: 2, sums: { user: 3 }, total: 3 }),
				step({ i: 3, turn: 2, sums: { user: 4 }, total: 4 }),
			] as never,
			geo as never,
			{ mode: "total", granularity: "turn", duration: false } as never,
		);
		expect(data.bars.map((bar: { step: number }) => bar.step)).toEqual([1, 3]);
	});

	it("carries flags, the turn band and step labels", () => {
		const data = load().buildTimeline(
			[
				step({ i: 0, turn: 1, sums: { user: 1 }, total: 1, ev: [7] }),
				step({ i: 1, turn: 1, sums: { user: 2 }, total: 2, ev: [] }),
			] as never,
			geo as never,
			{ mode: "total", granularity: "step", duration: false, eventKinds: { 7: "compaction" } } as never,
		);
		expect(data.flags).toHaveLength(1);
		expect(data.flags[0]).toMatchObject({ kind: "compaction", step: 0 });
		expect(data.turns).toHaveLength(1);
		expect(data.labels).toHaveLength(0);
	});

	it("caps the redraw at the same step count the server kept", () => {
		const many = Array.from({ length: 4100 }, (_, index) => step({ i: index, sums: { user: 1 }, total: 1 })) as never;
		expect(load().buildTimeline(many, geo as never, { mode: "total", granularity: "step", duration: false } as never).bars).toHaveLength(4000);
	});

	it("grows the canvas with the step count", () => {
		const many = Array.from({ length: 100 }, (_, index) => step({ i: index, sums: { user: 1 }, total: 1 })) as never;
		expect(load().buildTimeline(many, geo as never, { mode: "total", granularity: "step", duration: false } as never).width).toBeGreaterThan(1000);
	});

	it("widens the bars when turn mode collapses many steps into a few buckets", () => {
		const { timelineGeometry } = load();
		expect(timelineGeometry(20).barW).toBe(24);
		expect(timelineGeometry(0).barW).toBe(24);
		expect(timelineGeometry(200).barW).toBeLessThan(timelineGeometry(20).barW);
		expect(timelineGeometry(200).axisY).toBe(timelineGeometry(2).axisY);
		expect(timelineGeometry(200).height).toBe(240);
	});

	it("labels turn buckets with the turn number", () => {
		const steps = Array.from({ length: 10 }, (_, index) => step({ i: index, turn: index + 1, sums: { user: 1 }, total: 1 })) as never;
		const data = load().buildTimeline(steps, geo as never, { mode: "total", granularity: "turn", duration: false } as never);
		expect(data.labels.map((label) => label.text)).toEqual(["T5", "T10"]);
	});

	it("draws one band column per turn in turn mode and a spanning band in step mode", () => {
		const steps = [
			step({ i: 0, turn: 1, sums: { user: 1 }, total: 1 }),
			step({ i: 1, turn: 1, sums: { user: 2 }, total: 2 }),
			step({ i: 2, turn: 2, sums: { user: 3 }, total: 3 }),
		] as never;
		const byTurn = load().buildTimeline(steps, geo as never, { mode: "total", granularity: "turn", duration: false } as never);
		expect(byTurn.turns.map((turn) => turn.width)).toEqual([geo.barW, geo.barW]);
		const byStep = load().buildTimeline(steps, geo as never, { mode: "total", granularity: "step", duration: false } as never);
		expect(byStep.turns.map((turn) => turn.width)).toEqual([2 * (geo.barW + geo.gap) - geo.gap, geo.barW]);
	});

	it("keeps milestone flags on the turn column instead of the step column", () => {
		const steps = [
			step({ i: 0, turn: 1, sums: { user: 1 }, total: 1, ev: [9] }),
			step({ i: 1, turn: 1, sums: { user: 2 }, total: 2, ev: [] }),
			step({ i: 2, turn: 2, sums: { user: 3 }, total: 3, ev: [] }),
		] as never;
		const data = load().buildTimeline(steps, geo as never, {
			mode: "total",
			granularity: "turn",
			duration: false,
			eventKinds: { 9: "compaction" },
		} as never);
		expect(data.flags).toHaveLength(1);
		expect(data.flags[0]).toMatchObject({ kind: "compaction", count: 1 });
		expect(data.flags[0]?.x).toBeLessThan(geo.barW + 12);
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

describe("browser pane labels", () => {
	it("routes every pane and chip label through the dictionary helper", () => {
		expect(CLIENT_RUNTIME).toContain("catLabelFor(payload.dicts");
		expect(CLIENT_RUNTIME).toContain("groupLabelFor(payload.dicts");
		expect(CLIENT_RUNTIME).not.toMatch(/textContent = item\.cat/);
		expect(CLIENT_RUNTIME).not.toMatch(/item\.cat \+ " \u00b7 "/);
	});
	it("keeps the tool source chip when it rebuilds a row", () => {
		expect(CLIENT_RUNTIME).toContain('"data-tool-source"');
	});
	it("filters by category index through aria-pressed", () => {
		expect(CLIENT_RUNTIME).toContain("applyIndexFilter");
		expect(CLIENT_RUNTIME).toContain("data-cat-index");
	});
});

interface FakeNode {
	attrs: Record<string, string>;
	textContent: string;
	getAttribute: (name: string) => string | null;
	setAttribute: (name: string, value: string) => void;
	removeAttribute: (name: string) => void;
}

function fakeNode(attrs: Record<string, string>, text = ""): FakeNode {
	const node: FakeNode = {
		attrs: { ...attrs },
		textContent: text,
		getAttribute: (name) => node.attrs[name] ?? null,
		setAttribute: (name, value) => {
			node.attrs[name] = value;
		},
		removeAttribute: (name) => {
			delete node.attrs[name];
		},
	};
	return node;
}

function fakeDoc(groups: Record<string, FakeNode[]>) {
	const root = fakeNode({});
	return {
		documentElement: root,
		querySelectorAll: (selector: string) => groups[selector] ?? [],
		querySelector: (selector: string) => groups[selector]?.[0] ?? null,
	};
}

describe("language switching", () => {
	it("interpolates params carried by data-i18n-params", () => {
		const node = fakeNode({ "data-i18n": "browser.items", "data-i18n-params": '{"count":7}' });
		const doc = fakeDoc({ "[data-i18n]": [node] });
		load().applyLanguageFromDoc(doc as never, "zh", {
			zh: { "browser.items": "{count} 条" },
			en: { "browser.items": "{count} items" },
		} as never);
		expect(node.textContent).toBe("7 条");
	});

	it("decodes the escaped attribute entities before parsing params", () => {
		const node = fakeNode({ "data-i18n": "browser.skillTag", "data-i18n-params": '{"name":"a&#39;b"}' });
		const doc = fakeDoc({ "[data-i18n]": [node] });
		load().applyLanguageFromDoc(doc as never, "zh", { zh: { "browser.skillTag": "技能 · {name}" }, en: {} } as never);
		expect(node.textContent).toBe("技能 · a'b");
	});

	it("sets documentElement.lang and the button state", () => {
		const en = fakeNode({ "data-lang-switch": "en" });
		const zh = fakeNode({ "data-lang-switch": "zh" });
		const doc = fakeDoc({ "[data-i18n]": [], "[data-lang-switch]": [en, zh] });
		load().applyLanguageFromDoc(doc as never, "zh", { zh: {}, en: {} } as never);
		expect(doc.documentElement.attrs.lang).toBe("zh");
		expect(zh.attrs["aria-pressed"]).toBe("true");
		expect(en.attrs["aria-pressed"]).toBe("false");
	});

	it("retitles the document from the dictionary and the session title", () => {
		const title = fakeNode({ "data-i18n-title": "1" }, "会话洞察 — demo");
		const doc = fakeDoc({ "[data-i18n]": [], "[data-i18n-title]": [title] });
		const runtime = load();
		runtime.applyLanguageFromDoc(doc as never, "en", { en: { "doc.title": "Session Insight" } } as never, { sessionTitle: "demo" } as never);
		expect(title.textContent).toBe("Session Insight — demo");
	});

	it("marks exactly one rail item as current", () => {
		const items = ["tokens", "browser", "events"].map((id) => fakeNode({ "data-rail-item": id }));
		const doc = fakeDoc({ "[data-rail-item]": items });
		load().highlightRailFromDoc(doc as never, "browser");
		expect(items.filter((node) => node.attrs["aria-current"] === "true")).toHaveLength(1);
		expect(items[1].attrs["aria-current"]).toBe("true");
	});
});
