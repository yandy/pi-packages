import { describe, expect, it } from "vitest";
import { createSubagentSession } from "../../src/lifecycle/create-subagent-session";
import { assembleSessionConfig } from "../../src/session/session-config";
import { STUB_SNAPSHOT } from "../helpers/stub-ctx";
import {
	createAgentLookup,
	createSubagentSessionDeps,
	createSubagentSessionIO,
} from "../helpers/subagent-session-io";

/**
 * Contract: a child always runs in the parent's cwd — there is no per-call
 * override on the factory and no override on the assembler.
 */

describe("child cwd — the parent cwd is the only source", () => {
	it("factory ignores a cwd handed to it and uses the parent snapshot cwd", async () => {
		const io = createSubagentSessionIO();
		const registry = createAgentLookup();
		io.createSession.mockResolvedValue({ session: { bindExtensions: async () => {}, getActiveToolNames: () => [], setActiveToolsByName: () => {}, dispose: () => {} } });

		// `cwd` is not part of the params type anymore; a caller that still passes it
		// (JS, older code, a stale build) must not be able to redirect the child.
		await createSubagentSession(
			{ snapshot: STUB_SNAPSHOT, type: "Explore", cwd: "/elsewhere" } as never,
			createSubagentSessionDeps({ io, exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }) as never, registry }),
		);

		expect(io.createResourceLoader).toHaveBeenCalledWith(expect.objectContaining({ cwd: STUB_SNAPSHOT.cwd }));
		expect(io.createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: STUB_SNAPSHOT.cwd }));
	});

	it("assembler always resolves the parent cwd, ignoring any per-call override", () => {
		const registry = createAgentLookup();
		const io = {
			buildReplacePrompt: () => "replace prompt",
			buildAppendSection: () => "append section",
		};
		const env = { isGitRepo: false, branch: "", platform: "linux" };

		const result = assembleSessionConfig(
			"Explore",
			{ cwd: "/parent", modelRegistry: { find: () => undefined } },
			{ cwd: "/elsewhere" } as never,
			env,
			registry,
			io,
		);

		expect(result.effectiveCwd).toBe("/parent");
	});
});
