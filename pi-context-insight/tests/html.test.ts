import type { Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { clipText, escapeHtml, formatCost, formatDuration, formatTokens } from "../src/format";
import { renderInsightHtml } from "../src/html";
import type { ContextCategoryId, InsightReport, UsageAggregate, UsageLedgerItem } from "../src/model";
import { analyzeSessionManager } from "../src/report";
import { summarizeUsage } from "../src/usage";

const CATEGORY_IDS: ContextCategoryId[] = ["system", "toolDefinitions", "user", "injected", "compaction", "reasoning", "answers", "toolCalls", "toolResults"];

function aggregate(): UsageAggregate {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, prompt: 0, total: 0, cost: 0, cacheHitRate: null, costBasis: "estimate" };
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function appendAssistant(manager: SessionManager, tokens: Usage, command?: string): void {
	manager.appendMessage({
		role: "assistant",
		content: command
			? [{ type: "toolCall", id: `call-${command}`, name: "bash", arguments: { command } }]
			: [{ type: "text", text: "RAW ASSISTANT BODY" }],
		api: "anthropic-messages",
		provider: "provider-a",
		model: "model-a",
		usage: tokens,
		stopReason: command ? "toolUse" : "stop",
		timestamp: 1,
		durationMs: 25,
	});
}

function fullReport(): InsightReport {
	const parent = SessionManager.inMemory("/tmp/parent");
	parent.appendSessionInfo("Report <img src=x onerror=alert(1)>");
	appendAssistant(parent, usage(100, 20, 30, 10, 0.2), "</code><script>alert(1)</script>");
	parent.appendMessage({
		role: "toolResult",
		toolCallId: "call-</code><script>alert(1)</script>",
		toolName: "bash",
		content: [{ type: "text", text: "RAW SECRET OUTPUT" }],
		details: { exitCode: 0 },
		isError: false,
		timestamp: 2,
		durationMs: 40,
	});
	parent.appendUsage("subagent", "provider-b", "model-b", usage(60, 5, 10, 0, 0.3), "Subagent child");
	parent.appendCompaction("RAW COMPACTION BODY", null, 100, undefined, undefined, usage(10, 2, 0, 0, 0.05));
	parent.appendModelChange("p\" onmouseover=\"x", "model&1");
	const edited = parent.appendMessage({ role: "user", content: "old", timestamp: 3 });
	parent.appendContextEdit(edited, { content: "new \"quote\" & value" });
	parent.appendCustomEntry("subagents:record", { id: "child-agent", type: "Explore", description: "Child & <Explorer>", status: "completed", result: "SENSITIVE RESULT" });
	const session = analyzeSessionManager(parent, {
		cwd: "/tmp/\"quote\"&",
		model: "provider-a/model-a",
		contextUsage: { tokens: null, contextWindow: 1_000, percent: null },
		fallbackSystemPrompt: "system prompt",
	});

	const childManager = SessionManager.inMemory("/tmp/child");
	appendAssistant(childManager, usage(700, 50, 20, 7, 0.7));
	const child = analyzeSessionManager(childManager, { cwd: "/tmp/child" });
	return {
		...session,
		generatedAt: "2026-01-02T00:00:00.000Z",
		subagents: [
			{
				agent: { id: "child-agent", type: "Explore", description: "Child & <Explorer>", status: "completed", filePath: "/tmp/child.jsonl" },
				report: child,
			},
		],
	};
}

function emptyReport(): InsightReport {
	return {
		metadata: { id: "empty", cwd: "/tmp/empty" },
		generatedAt: "2026-01-02T00:00:00.000Z",
		usage: { items: [], warnings: [], total: aggregate(), direct: aggregate(), forwardedSubagents: aggregate(), byModel: [] },
		context: {
			usage: { tokens: null, contextWindow: 1_000, percent: null },
			categories: CATEGORY_IDS.map((id) => ({ id, tokens: id === "toolDefinitions" ? null : 0 })),
			estimatedTotal: 0,
			complete: false,
			warnings: [],
		},
		activity: { executions: [], tools: [], files: [], commands: [] },
		events: [],
		timing: { wallTimeMs: 0, modelTimeMs: 0, toolTimeMs: 0, modelTimeIncomplete: false, toolTimeEstimated: false },
		warnings: [],
		subagents: [],
	};
}

describe("format helpers", () => {
	it("escapes all HTML-special characters", () => {
		expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
	});
	it("formats numbers, cost, duration and clipped text", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1_000)).toBe("1.0k");
		expect(formatTokens(1_000_000)).toBe("1.0M");
		expect(formatCost(0.5)).toBe("$0.5000");
		expect(formatDuration(999)).toBe("999ms");
		expect(formatDuration(1_000)).toBe("1.0s");
		expect(formatDuration(60_000)).toBe("1.0m");
		expect(formatDuration(3_600_000)).toBe("1.0h");
		expect(clipText("abcdef", 5)).toBe("abcd…");
		expect(clipText("abc", 5)).toBe("abc");
	});
});

describe("HTML renderer", () => {
	it("renders a standalone report with separate parent and child accounting", () => {
		const html = renderInsightHtml(fullReport());
		expect(html).toMatch(/^<!doctype html>/i);
		expect(html).toContain("charset=\"utf-8\"");
		expect(html).toContain("name=\"viewport\"");
		expect(html).toContain("default-src 'none'");
		expect(html).toContain("script-src 'none'");
		expect(html).toContain("<style>");
		expect(html).toContain("Session total");
		expect(html).toContain("Parent direct");
		expect(html).toContain("Subagents forwarded");
		expect(html).toContain("Host context usage");
		expect(html).toContain("Estimated composition");
		expect(html).toContain("—");
		expect(html).toContain("<details class=\"subagent-card\"");
		expect(html).toContain("<details class=\"activity-details\"");
		expect(html.indexOf("777")).toBeGreaterThan(html.indexOf("<details class=\"subagent-card\""));
		expect(html).not.toMatch(/<(?:script|img|iframe|link)\b/i);
		expect(html).not.toMatch(/(?:src|href)=["']https?:/i);
	});

	it("escapes dynamic content and omits raw conversation and tool bodies", () => {
		const html = renderInsightHtml(fullReport());
		expect(html).toContain("Report &lt;img src=x onerror=alert(1)&gt;");
		expect(html).toContain("&lt;/code&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("/tmp/&quot;quote&quot;&amp;");
		expect(html).toContain("Child &amp; &lt;Explorer&gt;");
		expect(html).not.toContain("<img src=x onerror=alert(1)>");
		expect(html).not.toContain("</code><script>alert(1)</script>");
		expect(html).not.toContain("onmouseover=\"x\"");
		expect(html).not.toContain("RAW SECRET OUTPUT");
		expect(html).not.toContain("RAW COMPACTION BODY");
		expect(html).not.toContain("RAW ASSISTANT BODY");
		expect(html).not.toContain("SENSITIVE RESULT");
		expect(html).not.toContain("undefined");
		expect(html).not.toContain("NaN");
	});

	it("renders every ledger point and event markers with text alternatives", () => {
		const report = fullReport();
		const html = renderInsightHtml(report);
		const expectedPoints = report.usage.items.length + report.subagents.reduce((sum, child) => sum + child.report.usage.items.length, 0);
		const expectedEvents = report.events.length + report.subagents.reduce((sum, child) => sum + child.report.events.length, 0);
		expect(html.match(/class="usage-point"/g)).toHaveLength(expectedPoints);
		expect(html.match(/class="timeline-event"/g)).toHaveLength(expectedEvents);
		expect(html).toContain("aria-label=\"Recorded model usage timeline\"");
		expect(html).toContain("Compaction");
		expect(html).toContain("Context edit");
		for (const match of html.matchAll(/\b(?:x|y|width|height)="([^"]*)"/g)) {
			expect(Number.isFinite(Number(match[1]))).toBe(true);
		}
	});

	it("bounds detail rows and command length without truncating aggregates or timeline", () => {
		const report = emptyReport();
		const items: UsageLedgerItem[] = Array.from({ length: 201 }, (_, index) => ({
			entryId: `entry-${index}`,
			timestamp: new Date(index * 1_000).toISOString(),
			source: "assistant",
			usage: usage(1, 1, 0, 0),
		}));
		report.usage = summarizeUsage({ items, warnings: [] });
		report.activity.executions = items.map((item, index) => ({ id: item.entryId, name: "read", nested: false, status: "missing", timestamp: item.timestamp, durationMs: undefined, durationEstimated: false }));
		report.activity.tools = [{ name: "read", nested: false, calls: 201, ok: 0, errors: 0, missing: 201, unfinished: 0, durationMs: 0 }];
		report.activity.commands = [{ id: "long", source: "bash", nested: false, command: "x".repeat(1001), status: "missing", timestamp: new Date(0).toISOString(), exitCode: undefined, durationMs: undefined, durationEstimated: false }];

		const html = renderInsightHtml(report);
		expect(html.match(/class="execution-row"/g)).toHaveLength(200);
		expect(html.match(/class="usage-point"/g)).toHaveLength(201);
		expect(html).toContain("1 more record not shown");
		expect(html).toContain(`${"x".repeat(999)}…`);
		expect(html).not.toContain("x".repeat(1001));
	});

	it("renders useful empty states and nullable values", () => {
		const report = emptyReport();
		report.warnings.push("synthetic warning");
		report.usage.total.costBasis = "mixed";
		const html = renderInsightHtml(report);
		for (const text of ["No recorded model usage", "No subagents discovered", "No tool activity", "No file activity", "No command activity", "No context events", "synthetic warning", "Mixed"]) {
			expect(html).toContain(text);
		}
		expect(html).not.toContain("undefined");
		expect(html).not.toContain("NaN");
	});
});
