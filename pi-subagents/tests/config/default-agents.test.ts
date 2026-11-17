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
			const tools = get("Explore").builtinToolNames ?? [];
			expect(tools).toEqual(["read", "bash", "grep", "find", "ls"]);
			expect(tools).not.toContain("edit");
			expect(tools).not.toContain("write");
		});
	});

	describe("general-purpose", () => {
		it("appends to the harness-rendered prompt", () => {
			expect(get("general-purpose").promptMode).toBe("append");
		});

		it("leaves its tool set open (all available tools)", () => {
			expect(get("general-purpose").builtinToolNames).toBeUndefined();
		});
	});
});
