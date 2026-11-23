import { describe, expect, it } from "vitest";
import { runInsight } from "../src/command";
import { fakeContext } from "./helpers/ctx";
import {
	assistantEntry,
	compactionEntry,
	customMessageEntry,
	resetEntryIds,
	systemEntry,
	tool,
	toolCall,
	toolResultEntry,
	usage,
	userEntry,
} from "./helpers/entries";

const LONG_TEXT = Array.from({ length: 12 }, (_, i) => `line ${i + 1}: some representative payload text`).join("\n");
const TOOLS = ["read", "write", "edit", "bash", "grep", "todo", "subagent"];

/** A session that exercises every card: tools, files, commands, events, subagents, compaction. */
export function demoContext() {
	resetEntryIds();
	const entries: unknown[] = [
		systemEntry({
			sections: {
				preamble: "You are pi, a coding agent. ".repeat(40),
				skills: "## Skills\n- pdf\n- mediagen\n- playwright-cli",
				projectInstructions: "project rules ".repeat(60),
			},
			toolsAdded: TOOLS.map((name) => tool(name)),
			timestamp: 0,
		}),
	];
	let t = 1;
	const push = (entry: unknown) => entries.push(entry);
	const turn = (index: number) => {
		push(userEntry(`turn ${index}: 请帮我改造 pi-context-insight 报告 UI，参考 dsh-context`, t++));
		for (const [name, args] of [
			["read", { path: "src/render/style.ts" }],
			["read", { path: "src/render/document.ts" }],
			["grep", { pattern: "data-card" }],
			["edit", { path: "src/render/style.ts" }],
			["bash", { command: "npm test" }],
			["todo", { action: "set" }],
		] as const) {
			const id = `c${t}`;
			push(
				assistantEntry({
					content: [
						{ type: "thinking", thinking: `thinking about ${name} ${index} `.repeat(30) },
						toolCall(id, name, args),
					],
					usage: usage(60_000 + index * 4_000, 900, 20_000 + index * 3_000, 1_200, 0.18),
					durationMs: 2_400,
					timestamp: t++,
				}),
			);
			push(
				toolResultEntry({
					toolCallId: id,
					toolName: name,
					content: LONG_TEXT,
					isError: name === "bash",
					durationMs: name === "bash" ? 9_400 : 120,
					timestamp: t++,
				}),
			);
		}
		push(
			assistantEntry({
				content: [{ type: "text", text: "改完了，主要调整了卡片网格与图例排版。".repeat(20) }],
				usage: usage(80_000 + index * 5_000, 1_400, 30_000 + index * 4_000, 2_000, 0.24),
				durationMs: 3_100,
				timestamp: t++,
			}),
		);
	};
	turn(1);
	turn(2);
	push(customMessageEntry("ext:note", "扩展注入的上下文说明", t++));
	turn(3);
	push(
		compactionEntry({
			summary: "compaction summary ".repeat(80),
			tokensBefore: 168_000,
			firstKeptEntryId: "e2",
			timestamp: t++,
		}),
	);
	turn(4);
	entries.push({
		type: "custom",
		id: "r1",
		parentId: null,
		timestamp: new Date(t * 1000).toISOString(),
		customType: "subagents:record",
		data: {
			id: "a1",
			type: "Explore",
			description: "audit render modules",
			status: "completed",
			result: "found 3 layout issues",
			startedAt: 1,
			completedAt: 2,
			toolUses: 12,
			modelName: "ark/kimi-k3-1-pro",
			thinking: "high",
			lifetimeUsage: { input: 90_000, output: 8_000, cacheWrite: 0 },
			lifetimeCost: 0.42,
		},
	});
	const toolInfos = TOOLS.map((name) => ({
		name,
		description: "",
		parameters: {},
		exposure: "default",
		sourceInfo: {
			path: `pkg:${name}`,
			source: name === "bash" ? "builtin" : "pi-tools",
			scope: "user",
			origin: "package",
		},
	}));
	return fakeContext(
		{ entries: entries as never[], name: "报告 UI 改造", file: "/repo/.pi/sessions/s1.jsonl" },
		{ cwd: "/tmp", getAllTools: () => toolInfos },
	);
}

describe("demo report", () => {
	it.skipIf(process.env.INSIGHT_DEMO !== "1")("writes /tmp/insight-demo.html for visual review", async () => {
		const path = await runInsight("insight-demo.html --lang zh", demoContext(), {
			generatedAt: new Date("2026-11-23T10:00:00Z"),
			env: { LANG: "zh_CN.UTF-8" },
		});
		expect(path).toBe("/tmp/insight-demo.html");
	});
});
