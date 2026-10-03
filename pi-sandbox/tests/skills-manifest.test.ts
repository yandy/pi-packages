import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aclSkillPaths } from "../src/win32/skill-paths";

const skillDir = fileURLToPath(new URL("../skills/diagnose-windows-sandbox-acl", import.meta.url));

describe("diagnosis skill packaging", () => {
	it("ships the skill directory with SKILL.md", () => {
		expect(existsSync(`${skillDir}/SKILL.md`)).toBe(true);
	});

	it("declares name and a routing description in the frontmatter", () => {
		const raw = readFileSync(`${skillDir}/SKILL.md`, "utf8");
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw)?.[1];
		expect(frontmatter).toBeDefined();
		expect(frontmatter).toMatch(/^name: diagnose-windows-sandbox-acl$/mu);
		const description = /^description:\s*(.+)$/mu.exec(frontmatter ?? "")?.[1] ?? "";
		expect(description.length).toBeGreaterThan(40);
		expect(description.toLowerCase()).toContain("windows");
	});

	it("is reachable only through the win32 gating", () => {
		expect(aclSkillPaths("win32")).toEqual(["./skills/diagnose-windows-sandbox-acl"]);
		expect(aclSkillPaths("linux")).toEqual([]);
	});

	it("uses a relative skill path that resolves under the package root", () => {
		const [relative] = aclSkillPaths("win32");
		expect(relative?.startsWith("./skills/")).toBe(true);
		expect(existsSync(fileURLToPath(new URL(`../${relative?.slice(2)}`, import.meta.url)))).toBe(true);
	});

	it("keeps the skill out of the model catalog on non-Windows by returning an empty list", () => {
		// pi 侧语义：返回空数组 = 不追加任何技能路径（spec §4.10 已核实的 mergePaths 行为）
		expect(aclSkillPaths("darwin")).toHaveLength(0);
	});
});
