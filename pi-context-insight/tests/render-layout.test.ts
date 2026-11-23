import { describe, expect, it } from "vitest";
import { donut, stackBar } from "../src/render/charts";
import { chip, i18nAttrs, legendRow, microbar, section } from "../src/render/layout";
import { REPORT_CSS } from "../src/render/style";

describe("css contract", () => {
	it("wraps long unbroken strings instead of widening the page", () => {
		expect(REPORT_CSS).toContain("overflow-wrap:anywhere");
		expect(REPORT_CSS).toContain(".browser-scroll");
	});
	it("constrains long unbroken strings inside rows instead of widening the page", () => {
		expect(REPORT_CSS).toContain(".item-row>summary{");
		expect(REPORT_CSS).toContain("text-overflow:ellipsis");
		expect(REPORT_CSS).toContain(".main>*{min-width:0}");
		expect(REPORT_CSS).toContain("overflow-wrap:anywhere");
	});
	it("keeps the rail, the card grid and the print fallback", () => {
		expect(REPORT_CSS).toContain(".shell{");
		expect(REPORT_CSS).toContain(".span-6{");
		expect(REPORT_CSS).toContain("@media print");
		expect(REPORT_CSS).toContain("@media (max-width:900px)");
	});
});

describe("section", () => {
	it("carries id, card marker, span class and a translated title", () => {
		const html = section({ id: "tokens", titleKey: "tokens.title", lang: "en", span: 6, body: "x" });
		expect(html).toContain('id="tokens"');
		expect(html).toContain('data-card="tokens"');
		expect(html).toContain('class="card span-6"');
		expect(html).toContain('data-i18n="tokens.title"');
	});
	it("defaults to span 12 and renders meta on the right", () => {
		const html = section({ id: "notes", titleKey: "notes.title", lang: "en", meta: "<b>m</b>", body: "" });
		expect(html).toContain("span-12");
		expect(html).toContain('class="card-meta"');
		expect(html).toContain("<b>m</b>");
	});
});

describe("i18nAttrs", () => {
	it("emits params as JSON when present", () => {
		expect(i18nAttrs("browser.items", { count: 3 })).toBe('data-i18n="browser.items" data-i18n-params=\'{"count":3}\'');
		expect(i18nAttrs("rail.title")).toBe('data-i18n="rail.title"');
	});
	it("escapes quotes in params so the single quoted attribute cannot break", () => {
		const attrs = i18nAttrs("browser.items", { name: "a'b<c>" });
		const value = attrs.slice(attrs.indexOf("data-i18n-params="));
		expect(value.slice(value.indexOf("'") + 1, value.lastIndexOf("'"))).not.toContain("'");
		expect(value).not.toContain("<c>");
	});
});

describe("chip", () => {
	it("carries a tone class and optional translation attributes", () => {
		expect(chip({ text: "ok", tone: "ok" })).toContain('class="chip tone-ok"');
		expect(chip({ text: "混合口径", i18n: "chip.costBasis.mixed" })).toContain('data-i18n="chip.costBasis.mixed"');
	});
	it("escapes the text", () => {
		expect(chip({ text: "<svg onload=1>" })).not.toContain("<svg");
	});
});

describe("microbar", () => {
	it("sizes the bar by value/max", () => {
		expect(microbar({ value: 3, max: 12, tone: "user" })).toContain("width:25.0%");
	});
	it("collapses to zero width for a zero or non-finite max", () => {
		expect(microbar({ value: 3, max: 0 })).toContain("width:0.0%");
		expect(microbar({ value: 3, max: Number.NaN })).toContain("width:0.0%");
	});
});

describe("legendRow", () => {
	it("renders dot, label, value, share and an optional bar", () => {
		const html = legendRow({ id: "user", label: "用户消息", value: "≈64", share: "6.4%", bar: { value: 64, max: 1000 } });
		expect(html).toContain("var(--user)");
		expect(html).toContain("用户消息");
		expect(html).toContain("≈64");
		expect(html).toContain("6.4%");
		expect(html).toContain("width:6.4%");
	});
});

describe("donut and stackBar", () => {
	it("draws one arc per positive part and prints the center text", () => {
		const html = donut({ total: 100, parts: [{ id: "user", value: 60 }, { id: "answers", value: 40 }], center: "≈100", sub: "已用" });
		expect((html.match(/<circle/g) ?? []).length).toBe(2);
		expect(html).toContain("≈100");
	});
	it("titles each arc with the caller's label, never the internal id", () => {
		const html = donut({
			total: 100,
			parts: [{ id: "systemBase", value: 100, label: "系统提示词" }],
			center: "≈100",
			sub: "已用",
		});
		expect(html).toContain("<title>系统提示词</title>");
		expect(html).not.toContain("<title>systemBase</title>");
	});
	it("skips zero parts and tolerates a zero total", () => {
		const html = donut({ total: 0, parts: [{ id: "user", value: 0 }], center: "—", sub: "" });
		expect((html.match(/<circle/g) ?? []).length).toBe(0);
	});
	it("stacks segments by percentage and labels the bar", () => {
		const html = stackBar({ segments: [{ id: "user", pct: 25, title: "u" }], ariaLabel: "composition" });
		expect(html).toContain('role="img"');
		expect(html).toContain("width:25.0%");
		expect(html).toContain("var(--user)");
	});
});
