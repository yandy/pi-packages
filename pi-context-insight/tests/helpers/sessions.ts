import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fakeContext } from "./ctx";
import {
	assistantEntry,
	branchSummaryEntry,
	compactionEntry,
	customMessageEntry,
	resetEntryIds,
	systemEntry,
	tool,
	toolCall,
	toolResultEntry,
	usage,
	userEntry,
} from "./entries";

/** A session that carries one of every free-text channel the report can print. */
export function chattySession(cwd: string): ExtensionCommandContext {
	resetEntryIds();
	const entries = [
		systemEntry({ sections: { preamble: "prompt-sentinel", skills: "catalog" }, toolsAdded: [tool("read"), tool("bash")], timestamp: 0 }),
		userEntry("brief-sentinel", 1),
		customMessageEntry("ext:note", "injected-sentinel", 2),
		branchSummaryEntry("summary-sentinel", "e0", 3),
		assistantEntry({
			content: [{ type: "thinking", thinking: "thinking-sentinel" }, toolCall("c1", "read", { path: "a.txt" })],
			usage: usage(100, 10, 0, 0, 0.1),
			timestamp: 4,
		}),
		toolResultEntry({ toolCallId: "c1", toolName: "read", content: "tool-output-sentinel", timestamp: 5 }),
		assistantEntry({ content: [toolCall("c2", "bash", { command: "echo command-sentinel" })], usage: usage(110, 10, 0, 0, 0.1), timestamp: 6 }),
		toolResultEntry({ toolCallId: "c2", toolName: "bash", content: "output-sentinel\nCommand exited with code 1", isError: true, durationMs: 900, timestamp: 7 }),
		assistantEntry({ content: [toolCall("c3", "todo", { action: "set", items: [{ title: "todo-sentinel" }] })], usage: usage(120, 10, 0, 0, 0.1), timestamp: 8 }),
		toolResultEntry({ toolCallId: "c3", toolName: "todo", content: "ok", timestamp: 9 }),
		compactionEntry({ summary: "compaction-sentinel", tokensBefore: 500, firstKeptEntryId: "e2", timestamp: 10 }),
		assistantEntry({ content: [{ type: "text", text: "answer-sentinel" }], usage: usage(130, 10, 0, 0, 0.1), timestamp: 11 }),
	];
	const records = [
		{
			type: "custom",
			id: "r1",
			parentId: null,
			timestamp: new Date(12).toISOString(),
			customType: "subagents:record",
			data: {
				id: "a1",
				type: "explore",
				description: "description-sentinel",
				status: "completed",
				result: "result-sentinel",
				startedAt: 1,
				completedAt: 2,
				outputFile: "/tmp/does-not-exist.jsonl",
				lifetimeUsage: { input: 10, output: 5, cacheWrite: 0 },
				lifetimeCost: 0.01,
			},
		},
	];
	return fakeContext({ entries: [...entries, ...(records as never[])], name: "gate", file: join(cwd, "s.jsonl") }, { cwd });
}
