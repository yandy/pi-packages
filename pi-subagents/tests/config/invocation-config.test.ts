import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "../../src/config/invocation-config";
import type { AgentConfig } from "../../src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "Explore",
		description: "Explore",
		builtinToolNames: ["read"],
		systemPrompt: "Test agent",
		promptMode: "replace",
		inheritContext: false,
		runInBackground: false,
		...overrides,
	};
}

describe("resolveAgentInvocationConfig", () => {
	it("prefers agent config over tool-call params for locked fields", () => {
		const resolved = resolveAgentInvocationConfig(
			makeConfig({
				model: "provider/config-model",
				thinking: "high",
				maxTurns: 42,
				inheritContext: false,
				runInBackground: false,
			}),
			{
				model: "provider/param-model",
				thinking: "minimal",
				max_turns: 1,
				inherit_context: true,
				run_in_background: true,
			},
		);

		expect(resolved.modelInput).toBe("provider/config-model");
		expect(resolved.modelFromParams).toBe(false);
		expect(resolved.thinking).toBe("high");
		expect(resolved.maxTurns).toBe(42);
		expect(resolved.inheritContext).toBe(false);
		expect(resolved.runInBackground).toBe(false);
	});

	it("uses tool-call params when no agent config is available", () => {
		const resolved = resolveAgentInvocationConfig(undefined, {
			model: "provider/param-model",
			thinking: "minimal",
			max_turns: 3,
			inherit_context: true,
			run_in_background: true,
		});

		expect(resolved.modelInput).toBe("provider/param-model");
		expect(resolved.modelFromParams).toBe(true);
		expect(resolved.thinking).toBe("minimal");
		expect(resolved.maxTurns).toBe(3);
		expect(resolved.inheritContext).toBe(true);
		expect(resolved.runInBackground).toBe(true);
	});

	it("lets parent fill in booleans when config leaves them undefined", () => {
		const resolved = resolveAgentInvocationConfig(
			makeConfig({
				inheritContext: undefined,
				runInBackground: undefined,
			}),
			{
				inherit_context: true,
				run_in_background: true,
			},
		);

		expect(resolved.inheritContext).toBe(true);
		expect(resolved.runInBackground).toBe(true);
	});

	it("defaults booleans to false when neither config nor params set them", () => {
		const resolved = resolveAgentInvocationConfig(
			makeConfig({
				inheritContext: undefined,
				runInBackground: undefined,
			}),
			{},
		);

		expect(resolved.inheritContext).toBe(false);
		expect(resolved.runInBackground).toBe(false);
	});
});
