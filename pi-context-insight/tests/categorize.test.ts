import { describe, expect, it } from "vitest";
import { extractItems } from "../src/session/categorize";
import { replaySystem } from "../src/session/replay";
import {
	assistantEntry,
	resetEntryIds,
	systemEntry,
	tool,
	toolCall,
	toolResultEntry,
} from "./helpers/entries";

function harness(entries: Parameters<typeof replaySystem>[0], mode: "full" | "short" = "full") {
	const bodies: string[] = [];
	let id = 0;
	const callArgs = new Map<string, Record<string, unknown>>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content as Array<{ type: string; id?: string; arguments?: Record<string, unknown> }>) {
			if (block.type === "toolCall" && block.id) callArgs.set(block.id, block.arguments ?? {});
		}
	}
	const putBody = (text: string) => (mode === "short" ? null : (bodies.push(text), bodies.length - 1));
	const items = entries.flatMap((entry, index) =>
		extractItems({
			entry,
			system: replaySystem(entries.slice(0, index + 1)),
			nextId: () => id++,
			putBody,
			callArgs: (toolCallId) => callArgs.get(toolCallId),
		}),
	);
	return { items, bodies };
}

describe("extractItems", () => {
	it("splits system sections and tool definitions", () => {
		resetEntryIds();
		const { items } = harness([
			systemEntry({
				sections: { preamble: "base", project_context: "AGENTS", skills: "catalog" },
				toolsAdded: [tool("read")],
				timestamp: 1,
			}),
		]);
		expect(items.map((i) => i.category)).toEqual(["systemBase", "systemProject", "systemSkills", "toolDefinitions"]);
		expect(items.every((i) => i.tokens > 0)).toBe(true);
		expect(items[3]?.tag).toBe("read");
	});
	it("classifies assistant blocks", () => {
		resetEntryIds();
		const { items } = harness([
			assistantEntry({
				content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }, toolCall("c1", "read", { path: "a" })],
				timestamp: 1,
			}),
		]);
		expect(items.map((i) => [i.category, i.block])).toEqual([
			["reasoning", "thinking"],
			["answers", "text"],
			["toolCalls", "toolCall"],
		]);
	});
	it("marks skill loads via read of SKILL.md", () => {
		resetEntryIds();
		const { items } = harness([
			assistantEntry({ content: [toolCall("c1", "read", { path: "/repo/skills/pdf/SKILL.md" })], timestamp: 1 }),
			toolResultEntry({ toolCallId: "c1", toolName: "read", content: "skill body", timestamp: 2 }),
		]);
		expect(items.at(-1)?.category).toBe("skillInjections");
		expect(items.at(-1)?.skillName).toBe("pdf");
	});
	it("keeps error state and drops bodies in short mode", () => {
		resetEntryIds();
		const { items, bodies } = harness(
			[
				assistantEntry({ content: [toolCall("c1", "bash", { command: "ls" })], timestamp: 1 }),
				toolResultEntry({ toolCallId: "c1", toolName: "bash", content: "boom", isError: true, timestamp: 2 }),
			],
			"short",
		);
		expect(items.at(-1)?.isError).toBe(true);
		expect(bodies).toEqual([]);
		expect(items.every((i) => i.textIndex === null)).toBe(true);
	});
});
