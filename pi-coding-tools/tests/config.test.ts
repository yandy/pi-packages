import { afterEach, describe, expect, it, vi } from "vitest";

const baseTrue = {
	ast_grep_search: true,
	ast_grep_replace: true,
	lsp_symbols: true,
	lsp_hover: true,
	lsp_navigate: true,
};

describe("loadConfig", () => {
	afterEach(() => {
		vi.resetModules();
	});

	it("returns all-true defaults when no config files", async () => {
		vi.doMock("@earendil-works/pi-coding-agent", () => ({
			getAgentDir: () => "/nonexistent-agent-dir/agent",
			CONFIG_DIR_NAME: ".pi",
		}));
		const { loadConfig } = await import("../src/config");
		const cfg = loadConfig("/nonexistent-cwd");
		expect(cfg).toEqual(baseTrue);
	});

	it("ignores legacy ls/find/grep keys", async () => {
		vi.doMock("@earendil-works/pi-coding-agent", () => ({
			getAgentDir: () => "/nonexistent-agent-dir/agent",
			CONFIG_DIR_NAME: ".pi",
		}));
		vi.doMock("node:fs", () => ({
			readFileSync: (p: string) => {
				if (p.endsWith(".pi/coding-tools.json")) return JSON.stringify({ ls: false, find: false, grep: false });
				throw new Error("not found");
			},
		}));
		const { loadConfig } = await import("../src/config");
		const cfg = loadConfig("/proj");
		expect(cfg).toEqual(baseTrue);
	});

	it("merges global then project (project wins)", async () => {
		vi.doMock("@earendil-works/pi-coding-agent", () => ({
			getAgentDir: () => "/nonexistent-agent-dir/agent",
			CONFIG_DIR_NAME: ".pi",
		}));
		vi.doMock("node:fs", () => ({
			readFileSync: (p: string) => {
				if (p.endsWith("agent/coding-tools.json")) return JSON.stringify({ lsp_hover: false, lsp_symbols: false });
				if (p.endsWith(".pi/coding-tools.json")) return JSON.stringify({ lsp_hover: true });
				throw new Error("not found");
			},
		}));
		const { loadConfig } = await import("../src/config");
		const cfg = loadConfig("/proj");
		expect(cfg.lsp_hover).toBe(true); // project overrides global
		expect(cfg.lsp_symbols).toBe(false); // global only, not overridden by project
	});

	it("parses lsp block with disabled + servers", async () => {
		vi.doMock("@earendil-works/pi-coding-agent", () => ({
			getAgentDir: () => "/nonexistent-agent-dir/agent",
			CONFIG_DIR_NAME: ".pi",
		}));
		vi.doMock("node:fs", () => ({
			readFileSync: (p: string) => {
				if (p.endsWith(".pi/coding-tools.json"))
					return JSON.stringify({
						lsp: { disabled: true, servers: { clangd: { disabled: true } } },
					});
				throw new Error("not found");
			},
		}));
		const { loadConfig } = await import("../src/config");
		const cfg = loadConfig("/proj");
		expect(cfg.lsp?.disabled).toBe(true);
		expect(cfg.lsp?.servers?.clangd?.disabled).toBe(true);
	});
});
