import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../../src/config/default-agents";

function get(name: string) {
	const config = DEFAULT_AGENTS.get(name);
	if (!config) throw new Error(`missing default agent: ${name}`);
	return config;
}

describe("DEFAULT_AGENTS", () => {
	describe("model", () => {
		// A hardcoded model wins over the `model` param and, when the exact
		// "provider/modelId" is not available, fuzzy-matches a different model —
		// so built-in agents must stay unset and inherit the parent model.
		it("leaves Explore's model unset", () => {
			expect(get("Explore").model).toBeUndefined();
		});

		it("leaves general-purpose's model unset", () => {
			expect(get("general-purpose").model).toBeUndefined();
		});
	});

	describe("Explore", () => {
		it("owns its whole prompt (replace mode)", () => {
			expect(get("Explore").promptMode).toBe("replace");
		});

		it("is limited to read-only tools", () => {
			const tools = get("Explore").toolNames ?? [];
			expect(tools).toEqual(["read", "grep", "find", "ls"]);
			expect(tools).not.toContain("edit");
			expect(tools).not.toContain("write");
		});

		// `bash` and `powershell` are a platform pair: each throws when run where the
		// other is the shell, and bash is missing on many Windows installs. Naming
		// either one hands some hosts a tool that can only fail, so Explore gets none.
		it("grants no shell, and names no shell in its prompt", () => {
			const config = get("Explore");
			expect(config.toolNames).not.toContain("bash");
			expect(config.toolNames).not.toContain("powershell");
			expect(config.systemPrompt).not.toMatch(/\bbash\b/i);
			expect(config.systemPrompt).not.toMatch(/\bpowershell\b/i);
			expect(config.systemPrompt).toMatch(/no shell/i);
		});
	});

	describe("general-purpose", () => {
		it("appends to the harness-rendered prompt", () => {
			expect(get("general-purpose").promptMode).toBe("append");
		});

		it("inherits the parent's tools instead of naming a set", () => {
			expect(get("general-purpose").toolNames).toBeUndefined();
		});
	});
});
