import { dirname } from "node:path";
import type { MountSpec } from "./runtime";

/**
 * Parse all skills from the system prompt's <available_skills> XML block.
 *
 * The system prompt emitted by pi includes:
 *
 *   <available_skills>
 *     <skill>
 *       <name>ask-user</name>
 *       <description>...</description>
 *       <location>/path/to/SKILL.md</location>
 *     </skill>
 *   </available_skills>
 *
 * Returns each skill's <name> and the host file path from <location>.
 * Throws if the prompt is empty or contains no <available_skills> block.
 */
export function parseAvailableSkills(systemPrompt: string): Array<{
	name: string;
	hostFilePath: string;
}> {
	if (!systemPrompt) {
		throw new Error(
			"sandbox: getSystemPrompt() returned an empty system prompt. " +
				"Cannot discover skill mounts.",
		);
	}

	const skills: Array<{ name: string; hostFilePath: string }> = [];
	const regex = /<skill>\s*<name>([\s\S]*?)<\/name>[\s\S]*?<location>([\s\S]*?)<\/location>/g;

	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard RegExp exec loop idiom
	while ((match = regex.exec(systemPrompt)) !== null) {
		const rawName = match[1].trim();
		const rawLocation = match[2].trim();

		if (!rawName || !rawLocation) continue;

		skills.push({ name: rawName, hostFilePath: rawLocation });
	}

	if (skills.length === 0) {
		throw new Error(
			"sandbox: could not find any <available_skills> entries in the system prompt. " +
				"Cannot discover skill mounts.",
		);
	}

	return skills;
}

/**
 * Convert parsed skills into Docker mount specs.
 *
 * Each skill's parent directory (dirname of hostFilePath) is mounted
 * read-only at /skills/<name>/ inside the container.
 */
export function skillsToMountSpecs(
	skills: Array<{ name: string; hostFilePath: string }>,
): MountSpec[] {
	return skills.map((skill) => ({
		source: dirname(skill.hostFilePath),
		target: `/skills/${skill.name}`,
		mode: "ro" as const,
	}));
}

/**
 * Fix <location> tags in a system prompt to point inside the container.
 *
 * For each skill in the mapping, replaces its host file path in
 * <location> tags with the container path /skills/<name>/SKILL.md.
 * Uses whitespace-tolerant regex replacement to match regardless of
 * whitespace inside <location> tags.
 */
export function fixSkillLocations(
	prompt: string,
	mapping: Array<{ name: string; hostFilePath: string }>,
): string {
	let result = prompt;
	for (const { name, hostFilePath } of mapping) {
		const escaped = hostFilePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(
			`<location>\\s*${escaped}\\s*<\\/location>`,
			"g",
		);
		result = result.replace(regex, `<location>/skills/${name}/SKILL.md</location>`);
	}
	return result;
}
