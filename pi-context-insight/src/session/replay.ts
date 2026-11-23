import type { SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CategoryId } from "../model";

export interface ReplayedSystem {
	base: string;
	sections: Record<string, string>;
	tools: ToolDefinition[];
}

/** Which context category a named system-prompt section belongs to. */
export const SYSTEM_SECTION_CATEGORY: Record<string, CategoryId> = {
	preamble: "systemBase",
	tools: "systemTools",
	rules: "systemTools",
	project_context: "systemProject",
	skills: "systemSkills",
	docs: "systemDocs",
};

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (typeof block === "object" && block !== null && "text" in block ? String(block.text ?? "") : ""))
		.join("");
}

function applySections(sections: Record<string, string>, patch: Record<string, string | null> | undefined): void {
	if (!patch) return;
	for (const [name, value] of Object.entries(patch)) {
		if (value === null) delete sections[name];
		else sections[name] = value;
	}
}

function addTools(tools: ToolDefinition[], added: readonly unknown[] | undefined): void {
	if (!added) return;
	for (const candidate of added) {
		const tool = candidate as ToolDefinition;
		if (typeof tool?.name !== "string") continue;
		const index = tools.findIndex((existing) => existing.name === tool.name);
		if (index >= 0) tools[index] = tool;
		else tools.push(tool);
	}
}

function removeTools(tools: ToolDefinition[], removed: readonly unknown[] | undefined): void {
	if (!removed) return;
	for (const candidate of removed) {
		const name = (candidate as { name?: unknown }).name;
		if (typeof name !== "string") continue;
		const index = tools.findIndex((existing) => existing.name === name);
		if (index >= 0) tools.splice(index, 1);
	}
}

/**
 * Replay every system message (plus compaction snapshots) into the prompt and tool set
 * the model saw at that point. Returns null when the transcript never recorded one, which
 * is how sessions written before system messages were persisted look.
 */
export function replaySystem(entries: readonly SessionEntry[]): ReplayedSystem | null {
	const state: ReplayedSystem = { base: "", sections: {}, tools: [] };
	let seen = false;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "system") {
			const message = entry.message;
			state.base += textOf(message.content);
			applySections(state.sections, message.sections);
			addTools(state.tools, message.toolsAdded);
			removeTools(state.tools, message.toolsRemoved);
			seen = true;
			continue;
		}
		if (entry.type === "compaction" && entry.systemMessage) {
			const snapshot = entry.systemMessage;
			state.base = textOf(snapshot.content);
			state.sections = {};
			applySections(state.sections, snapshot.sections);
			state.tools = [];
			addTools(state.tools, snapshot.toolsAdded);
			seen = true;
		}
	}

	return seen ? state : null;
}
