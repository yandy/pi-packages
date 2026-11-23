import { describe, expect, it } from "vitest";
import { replaySystem } from "../src/session/replay";
import { compactionEntry, resetEntryIds, systemEntry, tool, userEntry } from "./helpers/entries";

describe("replaySystem", () => {
	it("patches sections by name and removes on null", () => {
		resetEntryIds();
		const state = replaySystem([
			systemEntry({ sections: { preamble: "base", docs: "docs text" }, timestamp: 1 }),
			systemEntry({ sections: { docs: null, addendum: "extra" }, timestamp: 2 }),
		]);
		expect(state?.sections.preamble).toBe("base");
		expect(state?.sections.docs).toBeUndefined();
		expect(state?.sections.addendum).toBe("extra");
	});
	it("adds, overrides and removes tools by name", () => {
		resetEntryIds();
		const state = replaySystem([
			systemEntry({ toolsAdded: [tool("read"), tool("web")], timestamp: 1 }),
			systemEntry({ toolsAdded: [tool("read", "read v2")], timestamp: 2 }),
			systemEntry({ toolsRemoved: [{ name: "web" }], timestamp: 3 }),
		]);
		expect(state?.tools.map((t) => t.name)).toEqual(["read"]);
		expect(state?.tools[0]?.description).toBe("read v2");
	});
	it("resets everything from a compaction snapshot", () => {
		resetEntryIds();
		const state = replaySystem([
			systemEntry({ sections: { preamble: "live base", docs: "d" }, toolsAdded: [tool("web")], timestamp: 1 }),
			compactionEntry({
				summary: "S",
				tokensBefore: 100,
				firstKeptEntryId: "e1",
				timestamp: 2,
				systemMessage: {
					role: "system",
					content: "",
					sections: { preamble: "snapshot base" },
					toolsAdded: [tool("read")],
					timestamp: 2,
				},
			}),
		]);
		expect(state?.sections.preamble).toBe("snapshot base");
		expect(state?.sections.docs).toBeUndefined();
		expect(state?.tools.map((t) => t.name)).toEqual(["read"]);
	});
	it("appends later content to the base prompt", () => {
		resetEntryIds();
		const state = replaySystem([
			systemEntry({ content: "one", timestamp: 1 }),
			systemEntry({ content: " two", timestamp: 2 }),
		]);
		expect(state?.base).toBe("one two");
	});
	it("returns null when the transcript never recorded a system message", () => {
		resetEntryIds();
		expect(replaySystem([userEntry("hi", 1)])).toBeNull();
	});
});
