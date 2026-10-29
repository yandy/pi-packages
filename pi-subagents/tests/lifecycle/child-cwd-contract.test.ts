import { describe, expect, it } from "vitest";
import { SubagentManager } from "../../src/lifecycle/subagent-manager";
import { SubagentsServiceAdapter } from "../../src/service/service-adapter";

/**
 * Contract: a child always runs in the parent's cwd.
 *
 * There is deliberately no provider-registration seam on the service. These
 * assertions exist so that reintroducing one is a conscious decision that turns
 * this file red first, rather than a quiet addition nobody reviews.
 */

describe("child cwd — no extension seam", () => {
	it("manager exposes no workspace provider registration or getter", () => {
		expect("registerWorkspaceProvider" in SubagentManager.prototype).toBe(false);
		expect(Object.getOwnPropertyDescriptor(SubagentManager.prototype, "workspaceProvider")).toBeUndefined();
	});

	it("service adapter exposes no workspace provider registration", () => {
		expect("registerWorkspaceProvider" in SubagentsServiceAdapter.prototype).toBe(false);
	});
});
