import { describe, expect, it } from "vitest";
import { buildPayload, serializePayload } from "../src/render/payload";
import { renderDocument } from "../src/render/document";
import { renderOverview } from "../src/render/overview";
import { buildReport } from "../src/report";
import { fakeContext } from "./helpers/ctx";
import { assistantEntry, resetEntryIds, systemEntry, usage, userEntry } from "./helpers/entries";

function report(mode: "full" | "short" = "full", extra: { content?: string } = {}) {
	resetEntryIds();
	const entries = [
		systemEntry({ sections: { preamble: "base" }, timestamp: 1 }),
		userEntry(extra.content ?? "hi", 2),
		assistantEntry({ content: [{ type: "text", text: "answer" }], usage: usage(100, 10, 400, 0, 0.25), timestamp: 3 }),
	];
	return buildReport(fakeContext({ entries, name: "demo" }), { mode, lang: "en" });
}

describe("serializePayload", () => {
	it("escapes the characters that could break out of a script tag", () => {
		const text = serializePayload({ body: "</script><b>&</b>" });
		expect(text).not.toContain("</script");
		expect(text).toContain("\\u003c");
		expect(text).toContain("\\u0026");
	});
});

describe("buildPayload", () => {
	it("carries steps, items and dictionaries but no bodies in short mode", () => {
		const short = JSON.parse(buildPayload(report("short"))) as Record<string, unknown>;
		expect(short.mode).toBe("short");
		expect(Array.isArray(short.steps)).toBe(true);
		expect(short.bodies).toEqual([]);
		expect((short.dicts as Record<string, unknown>).zh).toBeDefined();
	});
});

describe("renderDocument", () => {
	it("emits the strict CSP and the short-mode variant without images", () => {
		const full = renderDocument({ report: report("full"), body: "", payload: "{}" });
		expect(full).toContain("default-src 'none'");
		expect(full).toContain("img-src data:");
		const short = renderDocument({ report: report("short"), body: "", payload: "{}" });
		expect(short).not.toContain("img-src data:");
	});
	it("shows the raw-content banner only in full mode", () => {
		expect(renderDocument({ report: report("full"), body: "", payload: "{}" })).toContain("data-banner=\"raw-content\"");
		expect(renderDocument({ report: report("short"), body: "", payload: "{}" })).not.toContain("data-banner=");
	});
	it("renders a rail item per section and both language buttons inside the rail", () => {
		const html = renderDocument({ report: report(), body: "", payload: "{}" });
		expect(html.match(/data-rail-item="/g)).toHaveLength(9);
		const rail = html.slice(html.indexOf('class="rail"'), html.indexOf('class="main"'));
		expect(rail).toContain('data-lang-switch="en"');
		expect(rail).toContain('data-lang-switch="zh"');
	});
	it("leaves the agents section out of the rail when there are no subagents", () => {
		const html = renderDocument({ report: report(), body: "", payload: "{}" });
		expect(html).not.toContain('data-rail-item="family"');
		expect(html.match(/data-rail-item="/g)).toHaveLength(9);
	});
	it("wraps the report in a rail plus grid shell", () => {
		const html = renderDocument({ report: report(), body: '<section class="card span-6" id="tokens"></section>', payload: "{}" });
		expect(html).toContain('class="shell"');
		expect(html).toContain('class="rail"');
		expect(html).toContain('class="main"');
		expect(html).not.toContain("nav.anchors");
	});
	it("keeps the banner and the warnings inside the main grid", () => {
		const many = { ...report(), warnings: [{ key: "warning.noSystem" }] };
		const html = renderDocument({ report: many, body: "", payload: "{}" });
		const main = html.slice(html.indexOf('class="main"'));
		expect(main).toContain('data-banner="raw-content"');
		expect(main).toContain('data-card="warnings"');
	});
	it("caps the warning panel at eight entries", () => {
		const base = report();
		const many = { ...base, warnings: Array.from({ length: 11 }, () => ({ key: "warning.noSystem" })) };
		const html = renderDocument({ report: many, body: "", payload: "{}" });
		expect(html.match(/data-warning="/g)).toHaveLength(8);
		expect(html).toContain("data-warning-more");
	});
	it("lists truncation entries in the data notes", () => {
		const base = report();
		const html = renderDocument({
			report: { ...base, truncation: [{ kind: "body", limit: 4000, actual: 2 }] },
			body: "",
			payload: "{}",
		});
		expect(html).toContain('data-truncation="body"');
	});
});

describe("renderOverview", () => {
	it("renders six KPI tiles inside the overview card", () => {
		const html = renderOverview(report());
		expect(html.match(/data-kpi="/g)).toHaveLength(6);
		expect(html).toContain('data-card="overview"');
		expect(html).toContain('class="kpis"');
		expect(html).toContain("demo");
	});
	it("lays the session facts and the model ledger side by side", () => {
		const html = renderOverview(report());
		expect(html).toContain('data-block="session"');
		expect(html).toContain('data-block="byModel"');
	});
	it("names the cost basis with a translated chip, not a raw key", () => {
		const html = renderOverview(report());
		expect(html).toContain('data-i18n="chip.costBasis.');
		expect(html).not.toContain("cost.estimate");
	});
	it("bars the model rows by total tokens", () => {
		expect(renderOverview(report())).toContain('class="bar"');
	});
});
