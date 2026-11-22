import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextEvent } from "./model";

export function extractContextEvents(entries: readonly SessionEntry[]): ContextEvent[] {
	const events: ContextEvent[] = [];
	for (const entry of entries) {
		const base = { id: entry.id, timestamp: entry.timestamp };
		if (entry.type === "compaction") {
			events.push({ ...base, type: "compaction", label: "Compaction", tokensBefore: entry.tokensBefore });
		} else if (entry.type === "branch_summary") {
			events.push({ ...base, type: "branch_summary", label: "Branch summary", targetId: entry.fromId });
		} else if (entry.type === "context_edit") {
			events.push({ ...base, type: "context_edit", label: "Context edit", targetId: entry.targetId });
		} else if (entry.type === "model_change") {
			events.push({ ...base, type: "model_change", label: `Model: ${entry.provider}/${entry.modelId}` });
		} else if (entry.type === "thinking_level_change") {
			events.push({ ...base, type: "thinking_level_change", label: `Thinking: ${entry.thinkingLevel}` });
		} else if (entry.type === "custom" && entry.customType === "subagents:record") {
			const data = entry.data;
			if (typeof data !== "object" || data === null) continue;
			const record = data as { id?: unknown; status?: unknown; description?: unknown };
			if (typeof record.id !== "string" || typeof record.status !== "string") continue;
			const description = typeof record.description === "string" ? ` · ${record.description}` : "";
			events.push({
				...base,
				type: "subagent",
				label: `Subagent ${record.status}: ${record.id}${description}`,
				targetId: record.id,
			});
		}
	}
	return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
