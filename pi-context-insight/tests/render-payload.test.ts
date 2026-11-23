import { describe, expect, it } from "vitest";
import { payloadOf } from "../src/render/payload";
import { buildReport } from "../src/report";
import { fakeContext } from "./helpers/ctx";
import {
	assistantEntry,
	resetEntryIds,
	systemEntry,
	tool,
	toolCall,
	toolResultEntry,
	usage,
	userEntry,
} from "./helpers/entries";

function report() {
	resetEntryIds();
	const entries = [
		systemEntry({ sections: { preamble: "base" }, toolsAdded: [tool("read")], timestamp: 0 }),
		userEntry("hi", 1),
		assistantEntry({ content: [toolCall("c1", "read", { path: "a" })], usage: usage(100, 10, 0, 0, 0.1), timestamp: 2 }),
		toolResultEntry({ toolCallId: "c1", toolName: "read", content: "body", timestamp: 3 }),
	];
	const toolInfos = [
		{
			name: "read",
			description: "",
			parameters: {},
			exposure: "default",
			sourceInfo: { path: "builtin:read", source: "builtin", scope: "user", origin: "package" },
		},
	];
	return buildReport(fakeContext({ entries }, { getAllTools: () => toolInfos }), { mode: "full", lang: "en" });
}

describe("payloadOf additions", () => {
	it("carries the shared timeline geometry", () => {
		const geo = payloadOf(report()).geo;
		expect(geo.barW).toBeGreaterThan(0);
		expect(geo.axisY).toBe(geo.flagH + geo.chartH);
		expect(geo.height).toBe(240);
	});
	it("carries tool sources and per-step timestamps", () => {
		const payload = payloadOf(report());
		expect(payload.tools[0]).toMatchObject({ name: "read", source: "builtin" });
		expect(typeof payload.steps[0]?.ts).toBe("string");
	});
	it("carries the fields a client-rendered browser row needs", () => {
		const payload = payloadOf(report());
		const definition = payload.items.find((item) => item.kind === "toolDefinition");
		expect(definition?.src).toBe("builtin");
		expect(definition?.srcLabel).toBeDefined();
		const row = payload.items.find((item) => item.cat === "toolResults");
		expect(typeof row?.at).toBe("string");
		expect(row?.call).toBe("c1");
	});
	it("keeps raw bodies out of a short-mode payload", () => {
		resetEntryIds();
		const entries = [
			systemEntry({ sections: { preamble: "base" }, timestamp: 0 }),
			userEntry("hi", 1),
			assistantEntry({ content: [{ type: "text", text: "secret-sentinel" }], usage: usage(100, 10, 0, 0, 0.1), timestamp: 2 }),
		];
		const payload = payloadOf(buildReport(fakeContext({ entries }), { mode: "short", lang: "en" }));
		expect(payload.bodies).toEqual([]);
		expect(JSON.stringify(payload)).not.toContain("secret-sentinel");
	});
});
