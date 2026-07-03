import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import { fixSkillLocations, parseAvailableSkills, skillsToMountSpecs } from "../src/skills";

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

	it("returns prompt unchanged for empty mapping", () => {
		const prompt = "some prompt";
		expect(fixSkillLocations(prompt, [])).toBe(prompt);
	});
});
