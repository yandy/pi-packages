import { formatSkillAskPrompt } from "../../permission-prompts";
import type { PermissionCheckResult } from "../../types";
import type { GateDescriptor } from "./descriptor";

/**
 * Build a pure descriptor for the skill-input permission gate.
 *
 * Takes the pre-computed check result so the gate can reuse the result the
 * caller already obtained (e.g. to conditionally emit a deny warning) without
 * re-running the check inside the runner.
 */
export function describeSkillInputGate(
	skillName: string,
	agentName: string | null,
	preCheck: PermissionCheckResult,
): GateDescriptor {
	const message = formatSkillAskPrompt(skillName, agentName ?? undefined);
	return {
		surface: "skill",
		input: { name: skillName },
		preCheck,
		denialContext: {
			kind: "skill_input",
			skillName,
			agentName: agentName ?? undefined,
		},
		promptDetails: {
			source: "skill_input",
			agentName,
			message,
			skillName,
		},
		logContext: {
			source: "skill_input",
			skillName,
			agentName,
			message,
		},
		decision: {
			surface: "skill",
			value: skillName,
		},
	};
}
