import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { type ExtensionCommandContext, parseSessionEntries, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeActivity, analyzeTiming } from "../src/activity";
import { analyzeContextProjection } from "../src/context";
import { maxUsageTotal, renderInsightHtml } from "../src/html";
import { analyzeSessionManager, buildInsightReport } from "../src/report";
import { loadSubagentSessions } from "../src/subagents";
import { addRecord, createChild, createParent, tasksDir } from "./helpers/subagent-fixtures";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-insight-review-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function assistantWithContent(id: string, content: unknown): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: content as [],
			api: "anthropic-messages",
			provider: "p",
			model: "m",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

describe("review regression: legacy content", () => {
	it("skips null assistant tool content with a warning while retaining other calls", () => {
		const entries = [
			assistantWithContent("valid", [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }]),
			assistantWithContent("legacy-null", null),
		];
		const report = analyzeActivity(entries);
		expect(report.executions).toHaveLength(1);
		expect(report.warnings.join("\n")).toContain("legacy-null");
	});

	it("loads a child with null system content and reports the skipped metadata", () => {
		const parent = createParent(root);
		const child = createChild(parent, { activeAgent: "Explore" });
		const filePath = child.getSessionFile()!;
		const entries = parseSessionEntries(readFileSync(filePath, "utf8"));
		const system = entries.find((entry) => entry.type === "message" && entry.message.role === "system");
		expect(system).toBeDefined();
		Reflect.set(system!.message, "content", null);
		writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");

		const result = loadSubagentSessions(parent);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].metadata.type).toBe("unknown");
		expect(result.warnings.join("\n")).toContain("system content");
	});
});

describe("review regression: child analysis isolation", () => {
	it("keeps the parent and valid siblings when one child analysis fails", () => {
		const parent = createParent(root);
		const broken = createChild(parent);
		broken.appendMessage({
			role: "assistant",
			content: [null] as never,
			api: "anthropic-messages",
			provider: "p",
			model: "m",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 3,
		});
		const valid = createChild(parent);
		const sessions = [
			{ manager: broken, metadata: { id: "agent-broken", type: "Explore", description: "Broken", status: "untracked", filePath: broken.getSessionFile()! } },
			{ manager: valid, metadata: { id: "agent-valid", type: "Explore", description: "Valid", status: "untracked", filePath: valid.getSessionFile()! } },
		];
		const ctx = {
			cwd: root,
			sessionManager: parent,
			model: undefined,
			thinkingLevel: undefined,
			getContextUsage: () => undefined,
			getSystemPrompt: () => "",
		} as unknown as ExtensionCommandContext;

		const report = buildInsightReport(ctx, { loadChildren: () => ({ sessions, warnings: [] }) });
		expect(report.metadata.id).toBe(parent.getSessionId());
		expect(report.subagents.map((child) => child.agent.id)).toEqual(["agent-valid"]);
		expect(report.warnings.join("\n")).toContain("agent-broken");
	});
});

describe("review regression: unknown assistant blocks", () => {
	it("skips unknown and null blocks with warnings instead of fabricating tool calls", () => {
		const manager = SessionManager.inMemory(root);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "future-block", value: "future" }, null] as never,
			api: "anthropic-messages",
			provider: "p",
			model: "m",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 1,
		});
		const result = analyzeContextProjection(manager.buildSessionProjection());
		expect(result.categories.find((category) => category.id === "toolCalls")?.tokens).toBe(0);
		expect(result.complete).toBe(false);
		expect(result.warnings).toHaveLength(3);
	});
});

describe("review regression: excluded bash context", () => {
	it("omits excluded bash output while retaining ordinary bash executions", () => {
		const manager = SessionManager.inMemory(root);
		manager.appendMessage({ role: "bashExecution", command: "echo hidden", output: "x".repeat(10_000), exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 1 });
		manager.appendMessage({ role: "bashExecution", command: "echo visible", output: "ok", exitCode: 0, cancelled: false, truncated: false, timestamp: 2 });
		const result = analyzeContextProjection(manager.buildSessionProjection());
		expect(result.categories.find((category) => category.id === "user")?.tokens).toBe(estimateTextTokens("echo visible\nok"));
	});
});

describe("review regression: malformed outputFile", () => {
	it("rejects record metadata while retaining the valid scan as untracked", () => {
		const parent = createParent(root);
		const child = createChild(parent);
		const renamed = join(tasksDir(parent.getSessionFile()!), "agent-1.jsonl");
		renameSync(child.getSessionFile()!, renamed);
		addRecord(parent, { id: "agent-1", outputFile: 42 as unknown as string });

		const result = loadSubagentSessions(parent);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].metadata.status).toBe("untracked");
		expect(result.sessions[0].metadata.id).not.toBe("agent-1");
		expect(result.warnings.join("\n")).toContain("outputFile");
	});
});

describe("review regression: incomplete durations", () => {
	it("tracks known and missing tool durations and rejects negative model durations", () => {
		const entries: SessionEntry[] = [
			assistantWithContent("known", [{ type: "toolCall", id: "known", name: "read", arguments: {} }]),
			{
				type: "message",
				id: "result-known",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "toolResult", toolCallId: "known", toolName: "read", content: [], isError: false, timestamp: 2, durationMs: 50 },
			},
			assistantWithContent("missing", [{ type: "toolCall", id: "missing", name: "read", arguments: {} }]),
		];
		const activity = analyzeActivity(entries);
		expect(activity.tools[0]).toMatchObject({ durationKnown: true, durationIncomplete: true, durationMs: 50 });
		expect(analyzeTiming(entries, activity.executions)).toMatchObject({ toolTimeMs: 50, toolTimeIncomplete: true });

		const negative = assistantWithContent("negative", []);
		Reflect.set(negative.message, "durationMs", -50);
		expect(analyzeTiming([negative], [])).toMatchObject({ modelTimeMs: 0, modelTimeIncomplete: true });
	});

	it("renders an unknown cumulative tool duration as unknown instead of 0ms", () => {
		const manager = SessionManager.inMemory(root);
		manager.appendMessage(assistantWithContent("missing", [{ type: "toolCall", id: "missing", name: "read", arguments: {} }]).message);
		const session = analyzeSessionManager(manager, { cwd: root });
		const html = renderInsightHtml({ ...session, generatedAt: "2026-01-02T00:00:00.000Z", subagents: [] });
		expect(html).toContain("Cumulative tool time: —");
	});
});

describe("review regression: very large usage ledgers", () => {
	it("computes the timeline maximum without spreading 150,000 entries into function arguments", () => {
		const items = Array.from({ length: 150_000 }, (_, index): { entryId: string; timestamp: string; source: string; usage: Usage } => ({
			entryId: `entry-${index}`,
			timestamp: new Date(index).toISOString(),
			source: "assistant",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}));
		items[items.length - 1].usage.input = 10;
		expect(maxUsageTotal(items)).toBe(11);
	});
});

describe("review regression: bounded tool summaries", () => {
	it("renders at most 200 tool summary rows with an omission notice", () => {
		const manager = SessionManager.inMemory(root);
		const session = analyzeSessionManager(manager, { cwd: root });
		session.activity.tools = Array.from({ length: 201 }, (_, index) => ({
			name: `tool-${index}`,
			nested: false,
			calls: 1,
			ok: 0,
			errors: 0,
			missing: 1,
			unfinished: 0,
			durationMs: 0,
			durationKnown: false,
			durationIncomplete: true,
		}));
		const html = renderInsightHtml({ ...session, generatedAt: "2026-01-02T00:00:00.000Z", subagents: [] });
		expect(html.match(/class="tool-summary-row"/g)).toHaveLength(200);
		expect(html).toContain("1 more record not shown");
	});
});

describe("review regression: read-only session loading", () => {
	it("does not modify legacy child or ancestor JSONL bytes", () => {
		const original = createParent(join(root, "original"));
		const child = createChild(original);
		const originalFile = original.getSessionFile()!;
		const childFile = child.getSessionFile()!;
		for (const filePath of [originalFile, childFile]) {
			const entries = parseSessionEntries(readFileSync(filePath, "utf8"));
			const header = entries.find((entry) => entry.type === "session");
			Reflect.set(header!, "version", 1);
			writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
		}
		const originalBytes = readFileSync(originalFile, "utf8");
		const childBytes = readFileSync(childFile, "utf8");
		expect(originalBytes.endsWith("\n")).toBe(false);
		expect(childBytes.endsWith("\n")).toBe(false);
		const fork = createParent(join(root, "fork"), originalFile);
		addRecord(fork, { id: "agent-legacy", outputFile: childFile });

		const result = loadSubagentSessions(fork);
		expect(result.sessions).toHaveLength(1);
		expect(readFileSync(originalFile, "utf8")).toBe(originalBytes);
		expect(readFileSync(childFile, "utf8")).toBe(childBytes);
	});
});
