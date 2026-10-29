import { describe, expect, it, vi } from "vitest";
import { createSubagentSession } from "../../src/lifecycle/create-subagent-session";
import { SubagentManager } from "../../src/lifecycle/subagent-manager";
import { SubagentsServiceAdapter } from "../../src/service/service-adapter";
import { assembleSessionConfig } from "../../src/session/session-config";
import { STUB_SNAPSHOT } from "../helpers/stub-ctx";
import {
	createAgentLookup,
	createFactorySession,
	createSubagentSessionDeps,
	createSubagentSessionIO,
} from "../helpers/subagent-session-io";

/**
 * Contract: a child always runs in the parent's cwd, and there is no seam for
 * redirecting it — no provider registration, no per-call cwd. These assertions
 * turn red first if someone reintroduces one, instead of it landing quietly.
 */

describe("child cwd — no seam, single source", () => {
	it("exposes no workspace-provider registration on the service or the manager", () => {
		expect("registerWorkspaceProvider" in SubagentsServiceAdapter.prototype).toBe(false);
		expect("registerWorkspaceProvider" in SubagentManager.prototype).toBe(false);
		expect("workspaceProvider" in SubagentManager.prototype).toBe(false);
	});

	it("ignores a cwd handed to the factory and uses the parent snapshot cwd", async () => {
		const io = createSubagentSessionIO();
		io.createSession.mockResolvedValue({ session: createFactorySession() });

		// `cwd` is not part of the params type anymore; a JS caller or a stale build
		// that still passes it must not be able to redirect the child.
		await createSubagentSession(
			{ snapshot: STUB_SNAPSHOT, type: "Explore", cwd: "/elsewhere" } as never,
			createSubagentSessionDeps({ io, exec: vi.fn(), registry: createAgentLookup() }),
		);

		expect(io.createResourceLoader).toHaveBeenCalledWith(expect.objectContaining({ cwd: STUB_SNAPSHOT.cwd }));
	});

	it("resolves the parent cwd even when a stale per-call override is passed", () => {
		const result = assembleSessionConfig(
			"Explore",
			{ cwd: "/parent", modelRegistry: { find: () => undefined } },
			{ cwd: "/elsewhere" } as never,
			{ isGitRepo: false, branch: "", platform: "linux" },
			createAgentLookup(),
			{ buildReplacePrompt: () => "replace prompt", buildAppendSection: () => "append section" },
		);

		expect(result.effectiveCwd).toBe("/parent");
	});
});
