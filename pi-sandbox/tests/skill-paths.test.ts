import { describe, expect, it } from "vitest";
import { aclSkillPaths } from "../src/win32/skill-paths";

describe("acl diagnosis skill gating", () => {
	it("exposes the skill on Windows only", () => {
		expect(aclSkillPaths("win32")).toEqual(["./skills/diagnose-windows-sandbox-acl"]);
		expect(aclSkillPaths("linux")).toEqual([]);
		expect(aclSkillPaths("darwin")).toEqual([]);
	});
});
