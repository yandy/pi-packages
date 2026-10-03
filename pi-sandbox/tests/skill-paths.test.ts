import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aclSkillPaths } from "../src/win32/skill-paths";

const skillDir = fileURLToPath(new URL("../skills/diagnose-windows-sandbox-acl", import.meta.url));

describe("acl diagnosis skill gating", () => {
	it("exposes the skill on Windows only, as an absolute path", () => {
		const paths = aclSkillPaths("win32");
		expect(paths).toEqual([skillDir]);
		expect(isAbsolute(paths[0])).toBe(true);
		expect(aclSkillPaths("linux")).toEqual([]);
		expect(aclSkillPaths("darwin")).toEqual([]);
	});
});
