import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => hoisted.agentDir,
}));

import visionExtension from "../index.js";

// ---- fakes ---------------------------------------------------------------

function fakeModel(over: { id?: string; provider?: string; input?: string[] } = {}) {
	const id = over.id ?? "claude-haiku-4-5";
	return {
		id,
		name: id,
		provider: over.provider ?? "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: over.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	};
}

function fakeRegistry(models: any[] = []) {
	return {
		getAll: () => models,
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
	};
}

function createHarness() {
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const tools: any[] = [];
	const handlers: Record<string, Array<(event: any, ctx: any) => Promise<void>>> = {};
	const activeTools: string[] = [];
	const statuses: Record<string, string | undefined> = {};
	const notifications: Array<{ text: string; level: string }> = [];

	const pi = {
		registerCommand: (name: string, opts: any) => {
			commands[name] = opts;
		},
		registerTool: (def: any) => {
			tools.push(def);
		},
		on: (event: string, handler: any) => {
			(handlers[event] ??= []).push(handler);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => {
			activeTools.length = 0;
			activeTools.push(...next);
		},
	};

	visionExtension(pi as any);

	const ctx = (over: { model?: any; registry?: any } = {}) => ({
		hasUI: true,
		model: over.model,
		modelRegistry: over.registry ?? fakeRegistry(),
		ui: {
			notify: (text: string, level = "info") => {
				notifications.push({ text, level });
			},
			setStatus: (key: string, value: string | undefined) => {
				statuses[key] = value;
			},
		},
	});

	const sessionStart = async (over: { model?: any; registry?: any } = {}) => {
		for (const handler of handlers.session_start ?? []) await handler({}, ctx(over));
	};

	return { commands, tools, handlers, activeTools, statuses, notifications, ctx, sessionStart };
}

// ---- tests ---------------------------------------------------------------

describe("/vision command — default think level", () => {
	let dir: string;
	let h: ReturnType<typeof createHarness>;
	const configFile = () => join(dir, "vision-tools.json");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "vision-wiring-"));
		hoisted.agentDir = dir;
		h = createHarness();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes defaultThinkLevel for /vision config default-think-level high", async () => {
		await h.commands.vision.handler("config default-think-level high", h.ctx());
		// Task 2 阶段 `enabled` 仍在类型里，写出的文件还带 enabled —— Task 3 Step 1 会把它收紧为 toEqual
		expect(JSON.parse(readFileSync(configFile(), "utf8"))).toMatchObject({ defaultThinkLevel: "high" });
		expect(h.notifications.at(-1)?.text).toContain("default-think-level");
	});

	it("rejects an out-of-enum or mis-cased value without touching the file", async () => {
		await h.commands.vision.handler("config default-think-level high", h.ctx());
		await h.commands.vision.handler("config default-think-level ultra", h.ctx());
		expect(h.notifications.at(-1)?.level).toBe("warning");
		await h.commands.vision.handler("config default-think-level HIGH", h.ctx());
		expect(h.notifications.at(-1)?.level).toBe("warning");
		expect(JSON.parse(readFileSync(configFile(), "utf8"))).toMatchObject({ defaultThinkLevel: "high" });
	});

	it("no longer accepts /vision config default-reasoning", async () => {
		await h.commands.vision.handler("config default-reasoning high", h.ctx());
		expect(h.notifications.at(-1)?.level).toBe("warning");
		expect(existsSync(configFile())).toBe(false);
	});
});
