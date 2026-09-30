import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { fixSkillLocations, parseAvailableSkills, skillsToMountSpecs } from "../src/skills";

// Realistic Skill[] fixtures — if pi changes the Skill interface fields used
// by formatSkillsForPrompt, update these fixtures to match.
const realSkills: Skill[] = [
	{
		name: "ask-user",
		description: "Ask the user questions interactively",
		filePath: "/home/user/.pi/agent-code/npm/node_modules/@yandy0725/pi-ask-user/skills/ask-user/SKILL.md",
		baseDir: "/home/user/.pi/agent-code/npm/node_modules/@yandy0725/pi-ask-user/skills/ask-user",
		sourceInfo: { source: "npm", path: "/home/user/.pi/agent-code/npm/node_modules/@yandy0725/pi-ask-user" },
		disableModelInvocation: false,
	},
	{
		name: "find-docs",
		description: "Search for documentation and examples",
		filePath: "/home/user/.pi/agent-code/skills/find-docs/SKILL.md",
		baseDir: "/home/user/.pi/agent-code/skills/find-docs",
		sourceInfo: { source: "global-skills", path: "/home/user/.pi/agent-code/skills" },
		disableModelInvocation: false,
	},
	{
		name: "brainstorming",
		description: "Explore ideas before building",
		filePath: "/home/user/workspace/project/.agents/skills/brainstorming/SKILL.md",
		baseDir: "/home/user/workspace/project/.agents/skills/brainstorming",
		sourceInfo: { source: "project", path: "/home/user/workspace/project/.agents/skills" },
		disableModelInvocation: false,
	},
];

describe("parseAvailableSkills", () => {
	it("parses a single skill from <available_skills> XML", () => {
		const prompt = `<available_skills>
  <skill>
    <name>ask-user</name>
    <description>Ask the user questions</description>
    <location>/home/user/.pi/agent-code/npm/node_modules/@yandy0725/pi-ask-user/skills/ask-user/SKILL.md</location>
  </skill>
</available_skills>`;

		const result = parseAvailableSkills(prompt);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("ask-user");
		expect(result[0].hostFilePath).toContain("SKILL.md");
	});

	it("parses multiple skills", () => {
		const prompt = `<available_skills>
  <skill>
    <name>ask-user</name>
    <description>Ask user</description>
    <location>/a/SKILL.md</location>
  </skill>
  <skill>
    <name>find-docs</name>
    <description>Find docs</description>
    <location>/b/SKILL.md</location>
  </skill>
</available_skills>`;

		const result = parseAvailableSkills(prompt);
		expect(result).toHaveLength(2);
		expect(result[0].name).toBe("ask-user");
		expect(result[1].name).toBe("find-docs");
	});

	it("throws when systemPrompt is empty", () => {
		expect(() => parseAvailableSkills("")).toThrow("empty system prompt");
	});

	it("throws when no <available_skills> block exists", () => {
		expect(() => parseAvailableSkills("no skills here")).toThrow(
			"could not find any <available_skills>",
		);
	});

	it("handles whitespace and newlines inside name/location tags", () => {
		const prompt = `<available_skills>
  <skill>
    <name>
      my-skill
    </name>
    <description>desc</description>
    <location>
      /path/to/my-skill/SKILL.md
    </location>
  </skill>
</available_skills>`;

		const result = parseAvailableSkills(prompt);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("my-skill");
		expect(result[0].hostFilePath).toBe("/path/to/my-skill/SKILL.md");
	});

	it("skips skills where name or location is empty after trim", () => {
		const prompt = `<available_skills>
  <skill>
    <name></name>
    <location>/a/SKILL.md</location>
  </skill>
  <skill>
    <name>valid</name>
    <location>/b/SKILL.md</location>
  </skill>
</available_skills>`;

		const result = parseAvailableSkills(prompt);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("valid");
	});

	it("golden: round-trips pi's real formatSkillsForPrompt output", () => {
		// This is the format-change alert: if pi changes how it serializes
		// skills into XML, formatSkillsForPrompt will produce different output
		// and this test will fail — warning us to update parseAvailableSkills.
		const realXml = formatSkillsForPrompt(realSkills);

		const result = parseAvailableSkills(realXml);
		expect(result).toHaveLength(3);
		expect(result[0].name).toBe("ask-user");
		expect(result[0].hostFilePath).toBe(realSkills[0].filePath);
		expect(result[1].name).toBe("find-docs");
		expect(result[1].hostFilePath).toBe(realSkills[1].filePath);
		expect(result[2].name).toBe("brainstorming");
		expect(result[2].hostFilePath).toBe(realSkills[2].filePath);

		// Verify the full pipeline: parse → mount specs → fix locations
		const mounts = skillsToMountSpecs(result);
		expect(mounts).toHaveLength(3);
		expect(mounts[0].target).toBe("/skills/ask-user");
		expect(mounts[1].target).toBe("/skills/find-docs");
		expect(mounts[2].target).toBe("/skills/brainstorming");

		const fixed = fixSkillLocations(realXml, result);
		expect(fixed).toContain("<location>/skills/ask-user/SKILL.md</location>");
		expect(fixed).toContain("<location>/skills/find-docs/SKILL.md</location>");
		expect(fixed).toContain("<location>/skills/brainstorming/SKILL.md</location>");
		// Verify host paths are gone
		expect(fixed).not.toContain(realSkills[0].filePath);
		expect(fixed).not.toContain(realSkills[1].filePath);
		expect(fixed).not.toContain(realSkills[2].filePath);
	});

	it("golden: parses real pi <available_skills> fixture (format change alert)", () => {
		// This test uses a fixture that matches pi's current <available_skills> XML format.
		// If pi changes the format (tag names, structure, whitespace rules),
		// this test will fail — acting as an early warning to update parseAvailableSkills.
		//
		// To update the fixture when pi format changes intentionally:
		//   1. Capture a fresh system prompt from a real pi session
		//   2. Extract the <available_skills> block
		//   3. Replace tests/fixtures/available-skills-golden.xml
		//   4. Update parseAvailableSkills if needed
		//   5. Verify this test passes again
		const fixturePath = resolvePath(__dirname, "fixtures", "available-skills-golden.xml");
		const golden = readFileSync(fixturePath, "utf-8");

		const result = parseAvailableSkills(golden);
		expect(result).toHaveLength(3);
		expect(result[0].name).toBe("ask-user");
		expect(result[0].hostFilePath).toContain("pi-ask-user/skills/ask-user/SKILL.md");
		expect(result[1].name).toBe("find-docs");
		expect(result[1].hostFilePath).toContain("skills/find-docs/SKILL.md");
		expect(result[2].name).toBe("brainstorming");
		expect(result[2].hostFilePath).toContain(".agents/skills/brainstorming/SKILL.md");
	});
});

describe("skillsToMountSpecs", () => {
	it("converts skills to ro mount specs with /skills/<name> targets", () => {
		const skills = [
			{ name: "ask-user", hostFilePath: "/home/.pi/skills/ask-user/SKILL.md" },
			{ name: "find-docs", hostFilePath: "/home/.pi/skills/find-docs/SKILL.md" },
		];

		const mounts = skillsToMountSpecs(skills);
		expect(mounts).toHaveLength(2);
		expect(mounts[0]).toEqual({
			source: "/home/.pi/skills/ask-user",
			target: "/skills/ask-user",
			mode: "ro",
		});
		expect(mounts[1]).toEqual({
			source: "/home/.pi/skills/find-docs",
			target: "/skills/find-docs",
			mode: "ro",
		});
	});

	it("returns empty array for empty input", () => {
		expect(skillsToMountSpecs([])).toEqual([]);
	});
});

describe("fixSkillLocations", () => {
	const mapping = [
		{ name: "ask-user", hostFilePath: "/home/.pi/skills/ask-user/SKILL.md" },
		{ name: "find-docs", hostFilePath: "/home/.pi/skills/find-docs/SKILL.md" },
	];

	it("replaces host <location> paths with container paths", () => {
		const prompt = `<available_skills>
  <skill>
    <name>ask-user</name>
    <location>/home/.pi/skills/ask-user/SKILL.md</location>
  </skill>
</available_skills>`;

		const result = fixSkillLocations(prompt, [mapping[0]]);
		expect(result).toContain("<location>/skills/ask-user/SKILL.md</location>");
		expect(result).not.toContain("/home/.pi/skills/ask-user/SKILL.md");
	});

	it("replaces multiple skill locations", () => {
		const prompt = `<available_skills>
  <skill>
    <name>ask-user</name>
    <location>/home/.pi/skills/ask-user/SKILL.md</location>
  </skill>
  <skill>
    <name>find-docs</name>
    <location>/home/.pi/skills/find-docs/SKILL.md</location>
  </skill>
</available_skills>`;

		const result = fixSkillLocations(prompt, mapping);
		expect(result).toContain("<location>/skills/ask-user/SKILL.md</location>");
		expect(result).toContain("<location>/skills/find-docs/SKILL.md</location>");
		expect(result).not.toContain("/home/.pi/skills/");
	});

	it("handles whitespace inside <location> tags", () => {
		const prompt = `<available_skills>
  <skill>
    <name>ask-user</name>
    <location>
      /home/.pi/skills/ask-user/SKILL.md
    </location>
  </skill>
</available_skills>`;

		const result = fixSkillLocations(prompt, [mapping[0]]);
		expect(result).toContain("<location>/skills/ask-user/SKILL.md</location>");
		expect(result).not.toContain("/home/.pi/skills/");
	});

	it("returns prompt unchanged when no mapping entries match", () => {
		const prompt = "no skills here";
		const result = fixSkillLocations(prompt, mapping);
		expect(result).toBe(prompt);
	});

	it("returns empty array for empty input", () => {
		const prompt = "some prompt";
		expect(fixSkillLocations(prompt, [])).toBe(prompt);
	});
});
