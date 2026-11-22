import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultInsightPath, registerInsightCommand, runInsight } from "../src/command";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-insight-command-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function persistedSession(): SessionManager {
	const manager = SessionManager.create(root, join(root, "sessions"));
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	return manager;
}

function contextFor(manager: SessionManager, overrides: Record<string, unknown> = {}): ExtensionCommandContext {
	return {
		cwd: root,
		mode: "tui",
		hasUI: true,
		ui: { notify: vi.fn() },
		sessionManager: manager,
		model: undefined,
		thinkingLevel: undefined,
		waitForIdle: vi.fn().mockResolvedValue(undefined),
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		...overrides,
	} as unknown as ExtensionCommandContext;
}

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function captureHandler(): CommandHandler {
	let handler: CommandHandler | undefined;
	const pi = {
		registerCommand: (_name: string, options: { handler: CommandHandler }) => {
			handler = options.handler;
		},
	};
	registerInsightCommand(pi as unknown as ExtensionAPI);
	if (!handler) throw new Error("command handler was not registered");
	return handler;
}

describe("insight command", () => {
	it("waits for idle, writes the default report and notifies its path", async () => {
		const manager = persistedSession();
		let idle = false;
		const guarded = new Proxy(manager, {
			get(target, property, receiver) {
				if (property === "getEntries") {
					return () => {
						expect(idle).toBe(true);
						return target.getEntries();
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const waitForIdle = vi.fn(async () => {
			idle = true;
		});
		const ctx = contextFor(guarded, { waitForIdle });
		const handler = captureHandler();
		await handler("", ctx);

		const expected = join(root, `pi-insight-${basename(manager.getSessionFile()!, ".jsonl")}.html`);
		expect(waitForIdle).toHaveBeenCalledTimes(1);
		expect(readFileSync(expected, "utf8")).toContain("<!doctype html>");
		expect(ctx.ui.notify).toHaveBeenCalledWith(`Insight written to: ${expected}`, "info");
	});

	it("uses an in-memory session id and sanitizes fallback filename characters", async () => {
		const manager = SessionManager.inMemory(root, { id: "memory-session" });
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const ctx = contextFor(manager);
		const output = await runInsight("   ", ctx);
		expect(output).toBe(join(root, "pi-insight-memory-session.html"));
		expect(existsSync(output)).toBe(true);

		const unsafe = contextFor(manager, { sessionManager: { getSessionFile: () => undefined, getSessionId: () => "bad/id\\name" } });
		expect(defaultInsightPath(unsafe)).toBe(join(root, "pi-insight-bad_id_name.html"));
	});

	it("resolves custom paths with spaces and overwrites an existing file", async () => {
		const manager = persistedSession();
		const directory = join(root, "reports with spaces");
		mkdirSync(directory, { recursive: true });
		const output = join(directory, "insight report.html");
		writeFileSync(output, "old content", "utf8");

		const returned = await runInsight(join("reports with spaces", "insight report.html"), contextFor(manager));
		expect(returned).toBe(output);
		const html = readFileSync(output, "utf8");
		expect(html).toContain("<!doctype html>");
		expect(html).not.toContain("old content");
	});

	it("writes reports in RPC and no-UI contexts without relying on notify", async () => {
		const manager = persistedSession();
		const handler = captureHandler();
		const rpc = contextFor(manager, { mode: "rpc", hasUI: true, ui: { notify: vi.fn() } });
		await handler(join("rpc.html"), rpc);
		expect(existsSync(join(root, "rpc.html"))).toBe(true);

		const headless = contextFor(manager, { mode: "print", hasUI: false, ui: { notify: vi.fn() } });
		await handler(join("headless.html"), headless);
		expect(existsSync(join(root, "headless.html"))).toBe(true);
	});

	it("reports write failures without creating missing directories", async () => {
		const manager = persistedSession();
		const ctx = contextFor(manager);
		const handler = captureHandler();
		await handler(join("missing", "nested", "report.html"), ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/^Failed to generate insight: /), "error");
		expect(existsSync(join(root, "missing"))).toBe(false);
	});
});
