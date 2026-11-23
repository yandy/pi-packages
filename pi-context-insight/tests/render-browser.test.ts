import { describe, expect, it } from "vitest";
import { renderBrowser } from "../src/render/browser";
import { buildReport } from "../src/report";
import { fakeContext } from "./helpers/ctx";
import {
	assistantEntry,
	customMessageEntry,
	resetEntryIds,
	systemEntry,
	tool,
	toolCall,
	toolResultEntry,
	usage,
	userEntry,
} from "./helpers/entries";

function report(mode: "full" | "short" = "full", items = 3) {
	resetEntryIds();
	const entries = [systemEntry({ sections: { preamble: "base", skills: "catalog" }, toolsAdded: [tool("read")], timestamp: 0 })];
	let t = 1;
	entries.push(userEntry("hello", t++));
	for (let i = 0; i < items; i++) {
		entries.push(assistantEntry({ content: [toolCall(`c${i}`, "read", { path: `f${i}` })], usage: usage(100, 10, 0, 0, 0.1), timestamp: t++ }));
		entries.push(toolResultEntry({ toolCallId: `c${i}`, toolName: "read", content: `body ${i}`, timestamp: t++ }));
	}
	entries.push(customMessageEntry("ext:note", "injected text", t++));
	entries.push(assistantEntry({ content: [{ type: "text", text: "final answer" }], usage: usage(120, 12, 0, 0, 0.1), timestamp: t++ }));
	const toolInfos = [
		{
			name: "read",
			description: "read files",
			parameters: {},
			exposure: "default",
			sourceInfo: { path: "builtin:read", source: "builtin", scope: "user", origin: "package" },
		},
	];
	return buildReport(fakeContext({ entries }, { getAllTools: () => toolInfos }), { mode, lang: "en" });
}

describe("renderBrowser", () => {
	it("renders the step selector and the category rows in canonical order", () => {
		const html = renderBrowser(report());
		expect(html).toContain("data-browser-step");
		const cats = [...html.matchAll(/data-cat-row="([^"]+)"/g)].map((match) => match[1]);
		expect(cats).toEqual(["systemBase", "toolDefinitions", "user", "injected", "skillInjections", "compaction", "answers", "toolCalls", "toolResults", "unattributed"]);
	});
	it("renders the latest step panel with item rows", () => {
		const r = report();
		const html = renderBrowser(r);
		expect(html).toContain(`data-browser-panel="${r.steps.at(-1)?.index}"`);
		expect(html).toContain("data-item=");
		expect(html).toContain("data-search=");
	});
	it("keeps bodies out of short mode", () => {
		const html = renderBrowser(report("short"));
		expect(html).not.toContain('<pre class="body"');
		expect(html).toContain('data-empty="browser-body"');
	});
	it("labels tool sources", () => {
		const html = renderBrowser(report());
		expect(html).toContain('data-tool-source="builtin"');
	});
	it("offers more rows behind a disclosure instead of hiding them", () => {
		const html = renderBrowser(report("full", 210));
		expect(html).toContain('data-more="toolResults"');
		expect(html.match(/data-item="\d+" data-cat="toolResults"/g)?.length ?? 0).toBeGreaterThan(200);
	});
	it("renders dna rows for the selected step", () => {
		const html = renderBrowser(report());
		expect(html).toContain("data-dna-list");
		expect(html.match(/data-dna-item="/g)?.length ?? 0).toBeGreaterThan(0);
	});
});
