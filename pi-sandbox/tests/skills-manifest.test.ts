import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
		expect(aclSkillPaths("win32")).toEqual([skillDir]);
		expect(aclSkillPaths("linux")).toEqual([]);
	});

	// pi 把 resources_discover 返回的路径按会话 cwd 解析（resolveResourcePath = resolvePath(p, cwd)），
	// 所以这里必须是绝对路径——相对路径在真机上被证伪（spec §4.10）。
	it("returns an absolute skill path pointing at the packaged skill directory", () => {
		const [skillPath] = aclSkillPaths("win32");
		expect(isAbsolute(skillPath)).toBe(true);
		expect(skillPath).toBe(skillDir);
		expect(existsSync(join(skillPath, "SKILL.md"))).toBe(true);
	});

	it("keeps the skill out of the model catalog on non-Windows by returning an empty list", () => {
		// pi 侧语义：返回空数组 = 不追加任何技能路径（spec §4.10 已核实的 mergePaths 行为）
		expect(aclSkillPaths("darwin")).toHaveLength(0);
	});

	it("ships the repair script next to the skill", () => {
		expect(existsSync(`${skillDir}/scripts/diagnose-windows-sandbox-acl.ps1`)).toBe(true);
	});
});
