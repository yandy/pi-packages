import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { analyzeSessionManager, buildInsightReport } from "../src/report-v1";
import { addRecord, createChild, createParent } from "./helpers/subagent-fixtures";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-insight-report-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function appendAssistant(manager: SessionManager, tokens: Usage, timestamp: number, withTool = false): void {
	manager.appendMessage({
		role: "assistant",
		content: withTool ? [{ type: "toolCall", id: `call-${timestamp}`, name: "read", arguments: { path: "src/all.ts" } }] : [{ type: "text", text: "answer" }],
		api: "anthropic-messages",
		provider: "provider-a",
		model: "assistant-model",
		usage: tokens,
		stopReason: withTool ? "toolUse" : "stop",
		timestamp,
		durationMs: 50,
	});
}

function contextFor(manager: SessionManager, overrides: Record<string, unknown> = {}): ExtensionCommandContext {
	return {
		cwd: manager.getCwd(),
		sessionManager: manager,
		model: { provider: "provider-a", id: "current-model" },
		thinkingLevel: "high",
		getContextUsage: () => ({ tokens: 123, contextWindow: 1_000, percent: 12.3 }),
		getSystemPrompt: () => "fallback-system",
		...overrides,
	} as unknown as ExtensionCommandContext;
}

describe("session report orchestration", () => {
	it("keeps parent ledger totals separate from independently analyzed children", () => {
		const parent = createParent(root);
		appendAssistant(parent, usage(100, 20, 30, 10, 0.2), 1_000, true);
		parent.appendUsage("subagent", "provider-b", "forwarded-model", usage(60, 5, 10, 0, 0.3), "Subagent agent-1");
		parent.appendCompaction("visible-compaction", null, 200);
		const removed = parent.appendMessage({ role: "user", content: "remove-me", timestamp: 2_000 });
		const replaced = parent.appendMessage({ role: "user", content: "keep-original", timestamp: 3_000 });
		parent.appendContextEdit(removed, null);
		parent.appendContextEdit(replaced, { content: "replacement" });
		parent.appendSessionInfo("Insight parent");

		const firstChild = createChild(parent, { activeAgent: "Explore" });
		appendAssistant(firstChild, usage(50, 5, 10, 0, 0.1), 4_000, true);
		addRecord(parent, { id: "agent-1", outputFile: firstChild.getSessionFile(), type: "recorded-child" });
		const secondChild = createChild(parent);
		appendAssistant(secondChild, usage(20, 2, 0, 0, 0.02), 5_000);

		const generatedAt = new Date("2026-01-02T00:00:00.000Z");
		const report = buildInsightReport(contextFor(parent), { generatedAt });

		expect(report.generatedAt).toBe(generatedAt.toISOString());
		expect(report.metadata).toMatchObject({ id: parent.getSessionId(), name: "Insight parent", model: "provider-a/current-model", thinkingLevel: "high" });
		expect(report.usage.total).toMatchObject({ prompt: 210, output: 25, total: 235 });
		expect(report.usage.total.cost).toBeCloseTo(0.5, 10);
		expect(report.usage.direct.total).toBe(160);
		expect(report.usage.forwardedSubagents.total).toBe(75);
		expect(report.subagents).toHaveLength(2);
		expect(report.subagents[0].agent).toMatchObject({ id: "agent-1", type: "recorded-child", status: "completed" });
		expect(report.subagents[0].report.usage.total.total).toBe(65);
		expect(report.subagents[1].agent.status).toBe("untracked");
		expect(report.subagents[1].report.usage.total.total).toBe(22);

		expect(report.context.categories.find((category) => category.id === "user")?.tokens).toBe(estimateTextTokens("replacement"));
		expect(report.context.categories.find((category) => category.id === "compaction")?.tokens).toBe(estimateTextTokens("visible-compaction"));
		expect(report.context.usage).toEqual({ tokens: 123, contextWindow: 1_000, percent: 12.3 });
		expect(report.activity.executions.some((execution) => execution.id === "call-1000")).toBe(true);
	});

	it("preserves malformed-usage and child-scoped warnings", () => {
		const parent = createParent(root);
		const malformed = parent.appendUsage("cache_warm", "provider-a", "model", usage(1, 1, 0, 0, Number.NaN));
		const report = analyzeSessionManager(parent, { cwd: parent.getCwd(), fallbackSystemPrompt: "system" });
		expect(report.usage.total.total).toBe(0);
		expect(report.usage.warnings.join("\n")).toContain(malformed.id);
		expect(report.warnings).toEqual(expect.arrayContaining(report.usage.warnings));

		const child = createChild(parent);
		const loaded = buildInsightReport(contextFor(parent), {
			loadChildren: () => ({ sessions: [{ manager: child, metadata: { id: "agent-broken", type: "Explore", description: "Broken child", status: "untracked", filePath: child.getSessionFile()! } }], warnings: ["corrupt child file"] }),
		});
		expect(loaded.warnings).toContain("Subagent discovery: corrupt child file");
		expect(loaded.subagents).toHaveLength(1);
	});

	it("uses an injected empty loader instead of reading child directories", () => {
		const parent = createParent(root);
		createChild(parent);
		const contextUsage = vi.fn(() => ({ tokens: 1, contextWindow: 10, percent: 10 }));
		const report = buildInsightReport(contextFor(parent, { getContextUsage: contextUsage }), {
			loadChildren: () => ({ sessions: [], warnings: [] }),
		});
		expect(report.subagents).toEqual([]);
		expect(contextUsage).toHaveBeenCalledTimes(1);
	});
});
