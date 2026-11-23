import { describe, expect, it } from "vitest";
import { resolveToolNames } from "../../src/config/tool-names";

const PARENT = ["read", "bash", "edit", "write", "ext_tool"];

describe("resolveToolNames", () => {
	it("inherits the parent's tools minus dispatch tools when unset", () => {
		expect(resolveToolNames("general-purpose", undefined, [...PARENT, "subagent"])).toEqual(PARENT);
	});

	it("returns undefined when the parent set is unknown", () => {
		expect(resolveToolNames("general-purpose", undefined, undefined)).toBeUndefined();
	});

	it("keeps a known-empty parent set empty", () => {
		expect(resolveToolNames("general-purpose", undefined, [])).toEqual([]);
	});

	it("returns an empty list for none/empty", () => {
		expect(resolveToolNames("noedit", [], PARENT)).toEqual([]);
	});

	it("returns a plain list as-is, minus dispatch tools", () => {
		expect(resolveToolNames("auditor", ["read", "grep"], PARENT)).toEqual(["read", "grep"]);
		expect(resolveToolNames("sneaky", ["read", "subagent"], PARENT)).toEqual(["read"]);
	});

	it("applies +/- deltas to the inherited set, left to right", () => {
		expect(resolveToolNames("deltas", ["-edit", "-write", "+powershell"], PARENT)).toEqual([
			"read",
			"bash",
			"ext_tool",
			"powershell",
		]);
		// `+name` re-adds at the end, mirroring the host's applyToolModifiers.
		expect(resolveToolNames("redo", ["-edit", "+edit"], PARENT)).toEqual(["read", "bash", "write", "ext_tool", "edit"]);
		expect(resolveToolNames("missing", ["-nonexistent"], PARENT)).toEqual(PARENT);
	});

	it("passes deltas through untouched when the parent set is unknown", () => {
		expect(resolveToolNames("deltas", ["-edit"], undefined)).toEqual(["-edit"]);
	});

	it("dedupes while preserving first occurrence", () => {
		expect(resolveToolNames("dupes", ["read", "read", "grep"], [])).toEqual(["read", "grep"]);
		expect(resolveToolNames("dupes", undefined, ["read", "read"])).toEqual(["read"]);
	});

	it("rejects a list mixing plain names with modifiers, naming the type", () => {
		expect(() => resolveToolNames("mixed", ["read", "-edit"], PARENT)).toThrow(/"mixed"/);
		expect(() => resolveToolNames("mixed", ["read", "-edit"], PARENT)).toThrow(/cannot be mixed/);
	});

	it("rejects patterns in plain and modifier form", () => {
		expect(() => resolveToolNames("globby", ["*"], PARENT)).toThrow(/patterns|no wildcard/i);
		expect(() => resolveToolNames("globby", ["read*"], PARENT)).toThrow(/"globby"/);
		expect(() => resolveToolNames("globby", ["+web*"], PARENT)).toThrow(/"globby"/);
	});
});
