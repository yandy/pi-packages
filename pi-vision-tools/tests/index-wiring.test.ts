import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => hoisted.agentDir,
}));

vi.mock("../src/vision.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/vision.js")>();
	return { ...actual, callVision: async () => ({ text: "ok" }) };
});

vi.mock("../src/image.js", () => ({
	decodeImage: async () => ({ data: Buffer.from("x"), mimeType: "image/png" }),
}));

import visionExtension from "../index.js";
import { THINK_LEVELS } from "../src/config.js";

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
		input: over.input ?? ["text", "image"],
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
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
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
		expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ defaultThinkLevel: "high" });
		expect(h.notifications.at(-1)?.text).toContain("default-think-level");
	});

	it("rejects an out-of-enum or mis-cased value without touching the file", async () => {
		await h.commands.vision.handler("config default-think-level high", h.ctx());
		await h.commands.vision.handler("config default-think-level ultra", h.ctx());
		expect(h.notifications.at(-1)?.level).toBe("warning");
		await h.commands.vision.handler("config default-think-level HIGH", h.ctx());
		expect(h.notifications.at(-1)?.level).toBe("warning");
		expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ defaultThinkLevel: "high" });
	});

	it("no longer accepts /vision config default-reasoning", async () => {
		await h.commands.vision.handler("config default-reasoning high", h.ctx());
		expect(h.notifications.at(-1)?.level).toBe("warning");
		expect(existsSync(configFile())).toBe(false);
	});
});

describe("/vision command — auto-only activation", () => {
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

	it("rejects the removed on/off/auto subcommands without writing", async () => {
		for (const arg of ["on", "off", "auto"]) {
			await h.commands.vision.handler(arg, h.ctx());
			expect(h.notifications.at(-1)?.level).toBe("warning");
		}
		expect(existsSync(configFile())).toBe(false);
	});

	it("status shows the default think level and the activation state", async () => {
		const registry = fakeRegistry([fakeModel()]);
		await h.commands.vision.handler("config model haiku", h.ctx({ registry }));
		await h.commands.vision.handler("status", h.ctx({ registry }));
		const text = h.notifications.at(-1)?.text ?? "";
		expect(text).toContain("anthropic/claude-haiku-4-5");
		expect(text).toContain("default think level: off (built-in)");
		expect(text).toContain("active: yes");
	});

	it("status degrades gracefully when unconfigured or unresolvable", async () => {
		await h.commands.vision.handler("status", h.ctx());
		const unconfigured = h.notifications.at(-1)?.text ?? "";
		expect(unconfigured).toContain("(unconfigured)");
		expect(unconfigured).toContain("Run: /vision config model");

		const registry = fakeRegistry([fakeModel()]);
		await h.commands.vision.handler("config model nope", h.ctx({ registry }));
		await h.commands.vision.handler("status", h.ctx({ registry }));
		const text = h.notifications.at(-1)?.text ?? "";
		expect(text).toContain("nope (unresolved)");
		expect(text).toContain("Model not found");
	});

	it("activates the tool purely from the calling model, even after a corrupt config load", async () => {
		await h.sessionStart({ model: fakeModel({ input: ["text"] }) });
		expect(h.activeTools).toContain("describe_image");

		await h.sessionStart({ model: fakeModel({ input: ["text", "image"] }) });
		expect(h.activeTools).not.toContain("describe_image");

		writeFileSync(configFile(), "{ not json");
		await h.sessionStart({ model: fakeModel({ input: ["text"] }) });
		expect(h.activeTools).toContain("describe_image");
	});

	it("drives the footer indicator from the tool state and the resolved model", async () => {
		const registry = fakeRegistry([fakeModel()]);
		await h.commands.vision.handler("config model haiku", h.ctx({ registry }));
		await h.sessionStart({ model: fakeModel({ input: ["text"] }), registry });
		expect(h.statuses["pi-vision"]).toBe("👁 anthropic/claude-haiku-4-5");

		await h.sessionStart({ model: fakeModel({ input: ["text", "image"] }), registry });
		expect(h.statuses["pi-vision"]).toBeUndefined();
	});

	it("guards describe_image with a message that matches the live calling model", async () => {
		await h.sessionStart({ model: fakeModel({ input: ["text", "image"] }) });
		const tool = h.tools.find((t) => t.name === "describe_image");

		const visionCaller = await tool.execute(
			"call-1",
			{ image_path: "/tmp/does-not-matter.png", prompt: "hi" },
			undefined,
			undefined,
			h.ctx({ model: fakeModel({ input: ["text", "image"] }) }),
		);
		expect(visionCaller.isError).toBe(true);
		expect(visionCaller.content[0].text).toContain("calling model can see images itself");

		const blindCaller = await tool.execute(
			"call-2",
			{ image_path: "/tmp/does-not-matter.png", prompt: "hi" },
			undefined,
			undefined,
			h.ctx({ model: fakeModel({ input: ["text"] }) }),
		);
		expect(blindCaller.isError).toBe(true);
		expect(blindCaller.content[0].text).not.toContain("can see images itself");
		expect(blindCaller.content[0].text).toContain("not active for the current model");
	});
});

describe("describe_image tool schema", () => {
	it("exposes thinkLevel as the parameter name, not reasoning", () => {
		const h = createHarness();
		const tool = h.tools.find((t) => t.name === "describe_image");
		const props = Object.keys(tool.parameters.properties);
		expect(props).toContain("thinkLevel");
		expect(props).not.toContain("reasoning");
	});

	it("keeps the thinkLevel enum in sync with THINK_LEVELS", () => {
		const h = createHarness();
		const tool = h.tools.find((t) => t.name === "describe_image");
		expect(tool.parameters.properties.thinkLevel.enum).toEqual([...THINK_LEVELS]);
	});
});

describe("describe_image think level flow", () => {
	let dir: string;
	let h: ReturnType<typeof createHarness>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "vision-wiring-"));
		hoisted.agentDir = dir;
		h = createHarness();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** 先通过命令落盘 model（必要时带 default-think-level），再 session_start 读回配置，然后返回可用 registry。 */
	const prepare = async (configDefault?: string) => {
		const registry = fakeRegistry([fakeModel()]);
		await h.commands.vision.handler("config model haiku", h.ctx({ registry }));
		if (configDefault) await h.commands.vision.handler(`config default-think-level ${configDefault}`, h.ctx({ registry }));
		await h.sessionStart({ model: fakeModel({ input: ["text"] }), registry });
		return registry;
	};

	const runTool = async (registry: any, args: Record<string, unknown> = {}) => {
		const tool = h.tools.find((t) => t.name === "describe_image");
		return tool.execute(
			"call-1",
			{ image_path: "does-not-matter.png", prompt: "hi", compress: false, ...args },
			undefined,
			undefined,
			h.ctx({ registry, model: fakeModel({ input: ["text"] }) }),
		);
	};

	it("passes an explicit thinkLevel through to the result details", async () => {
		const registry = await prepare();
		const result = await runTool(registry, { thinkLevel: "high" });
		expect(result.isError).not.toBe(true);
		expect(result.details.thinkLevel).toBe("high");
	});

	it("falls back to the configured default think level", async () => {
		const registry = await prepare("medium");
		const result = await runTool(registry);
		expect(result.details.thinkLevel).toBe("medium");
	});

	it("lets an explicit thinkLevel win over the configured default", async () => {
		const registry = await prepare("high");
		const result = await runTool(registry, { thinkLevel: "low" });
		expect(result.details.thinkLevel).toBe("low");
	});
});
