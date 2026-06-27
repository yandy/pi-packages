import { afterEach, describe, expect, it, vi } from "vitest";

// Mock node:os so tilde-expansion is deterministic across platforms.
vi.mock("node:os", () => {
	const homedir = vi.fn(() => "/mock/home");
	return {
		homedir,
		default: { homedir },
	};
});

import { AccessPath } from "../../../src/access-intent/access-path";
import { BashProgram } from "../../../src/access-intent/bash/program";
import { describeBashPathGate } from "../../../src/handlers/gates/bash-path";
import type { GateBypass, GateDescriptor, GateResult } from "../../../src/handlers/gates/descriptor";
import { isGateBypass, isGateDescriptor } from "../../../src/handlers/gates/descriptor";
import type { ToolCallContext } from "../../../src/handlers/gates/types";
import type { ScopedPermissionResolver } from "../../../src/permission-resolver";
import { getNonEmptyString, toRecord } from "../../../src/value-guards";

import {
	makeGateCheckResult as makeCheckResult,
	makePathDispatchResolver,
	makeResolver,
	makeTcc,
} from "../../helpers/gate-fixtures";

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Mirror the handler's parse-once derivation: parse the bash command into a
 * shared `BashProgram` and inject it, exactly as `permission-gate-handler.ts`
 * does, so the gate is exercised through the production wiring.
 */
async function describeGate(tcc: ToolCallContext, resolver: ScopedPermissionResolver): Promise<GateResult> {
	const command = getNonEmptyString(toRecord(tcc.input).command);
	const bashProgram = tcc.toolName === "bash" && command ? await BashProgram.parse(command, tcc.cwd) : null;
	return describeBashPathGate(tcc, bashProgram, resolver);
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("describeBashPathGate", () => {
	it("returns null for non-bash tools", async () => {
		const result = await describeGate(makeTcc({ toolName: "read", input: { path: ".env" } }), makeResolver());
		expect(result).toBeNull();
	});

	it("returns null when no tokens are extracted", async () => {
		const result = await describeGate(makeTcc({ input: { command: "echo hello" } }), makeResolver());
		expect(result).toBeNull();
	});

	it("returns null when all tokens evaluate to allow", async () => {
		const result = await describeGate(makeTcc(), makeResolver(makeCheckResult({ state: "allow" })));
		expect(result).toBeNull();
	});

	it("returns GateDescriptor when a token evaluates to deny", async () => {
		const result = await describeGate(
			makeTcc(),
			makeResolver(makeCheckResult({ state: "deny", matchedPattern: "*.env" })),
		);
		expect(result).not.toBeNull();
		expect(isGateDescriptor(result)).toBe(true);
		const desc = result as GateDescriptor;
		expect(desc.surface).toBe("path");
		expect(desc.preCheck?.state).toBe("deny");
	});

	it("returns GateDescriptor when a token evaluates to ask", async () => {
		const result = await describeGate(makeTcc(), makeResolver(makeCheckResult({ state: "ask", matchedPattern: "*" })));
		expect(result).not.toBeNull();
		expect(isGateDescriptor(result)).toBe(true);
		const desc = result as GateDescriptor;
		expect(desc.preCheck?.state).toBe("ask");
	});

	it("descriptor includes triggering token in prompt message", async () => {
		const result = (await describeGate(
			makeTcc(),
			makeResolver(makeCheckResult({ state: "deny", matchedPattern: "*.env" })),
		)) as GateDescriptor;
		expect(result.denialContext).toMatchObject({
			kind: "bash_path",
			command: "cat .env",
			pathValue: ".env",
		});
		expect(result.promptDetails.message).toContain(".env");
	});

	it("descriptor decision uses surface 'path'", async () => {
		const result = (await describeGate(
			makeTcc(),
			makeResolver(makeCheckResult({ state: "deny", matchedPattern: "*.env" })),
		)) as GateDescriptor;
		expect(result.decision.surface).toBe("path");
	});

	it("returns GateBypass when session rule covers the path", async () => {
		const result = await describeGate(makeTcc(), makeResolver(makeCheckResult({ state: "allow", source: "session" })));
		expect(result).not.toBeNull();
		expect(isGateBypass(result)).toBe(true);
		expect((result as GateBypass).action).toBe("allow");
	});

	it("returns null when command is missing", async () => {
		const result = await describeGate(makeTcc({ input: {} }), makeResolver());
		expect(result).toBeNull();
	});

	it("evaluates most restrictive across multiple tokens", async () => {
		const resolver = makePathDispatchResolver(
			{ "src/foo.ts": makeCheckResult({ state: "allow" }) },
			makeCheckResult({ state: "deny", matchedPattern: "*.env" }),
		);
		const result = await describeGate(makeTcc({ input: { command: "cat src/foo.ts .env" } }), resolver);
		expect(result).not.toBeNull();
		expect(isGateDescriptor(result)).toBe(true);
		expect((result as GateDescriptor).preCheck?.state).toBe("deny");
	});

	it("deny wins in multi-token: cp .env README.md", async () => {
		const resolver = makePathDispatchResolver(
			{ ".env": makeCheckResult({ state: "deny", matchedPattern: "*.env" }) },
			makeCheckResult({ state: "allow" }),
		);
		const result = await describeGate(makeTcc({ input: { command: "cp .env README.md" } }), resolver);
		expect(result).not.toBeNull();
		expect(isGateDescriptor(result)).toBe(true);
		const desc = result as GateDescriptor;
		expect(desc.preCheck?.state).toBe("deny");
		expect(desc.decision.value).toBe(".env");
	});

	it("extracts redirect target: echo test > .env triggers deny", async () => {
		const resolver = makePathDispatchResolver(
			{ ".env": makeCheckResult({ state: "deny", matchedPattern: "*.env" }) },
			makeCheckResult({ state: "allow" }),
		);
		const result = await describeGate(makeTcc({ input: { command: "echo test > .env" } }), resolver);
		expect(result).not.toBeNull();
		expect(isGateDescriptor(result)).toBe(true);
		expect((result as GateDescriptor).preCheck?.state).toBe("deny");
	});

	it("returns null when all tokens match only the universal default", async () => {
		const result = await describeGate(
			makeTcc(),
			makeResolver(
				makeCheckResult({
					state: "ask",
					matchedPattern: undefined,
					source: "special",
					origin: "builtin",
				}),
			),
		);
		expect(result).toBeNull();
	});

	it("ignores tokens matching universal default but fires for explicit rule matches", async () => {
		const resolver = makePathDispatchResolver(
			{ ".env": makeCheckResult({ state: "deny", matchedPattern: "*.env" }) },
			// Other tokens match only the universal default (no matchedPattern)
			makeCheckResult({
				state: "ask",
				matchedPattern: undefined,
				source: "special",
				origin: "builtin",
			}),
		);
		const result = await describeGate(makeTcc({ input: { command: "cat src/foo.ts .env" } }), resolver);
		expect(result).not.toBeNull();
		expect(isGateDescriptor(result)).toBe(true);
		const desc = result as GateDescriptor;
		expect(desc.preCheck?.state).toBe("deny");
		expect(desc.decision.value).toBe(".env");
	});

	it("resolves cd-aware policy values while keeping the raw prompt token", async () => {
		const resolver = makeResolver(makeCheckResult({ state: "deny", matchedPattern: "*" }));
		const result = (await describeGate(
			makeTcc({
				input: { command: "cd nested && cat src/file.txt" },
				cwd: "/test/project",
			}),
			resolver,
		)) as GateDescriptor;

		expect(resolver.resolve).toHaveBeenCalledWith({
			kind: "access-path",
			surface: "path",
			path: AccessPath.forPath("src/file.txt", {
				cwd: "/test/project",
				resolveBase: "/test/project/nested",
			}),
			agentName: undefined,
		});
		// The raw token drives the prompt, denial context, and session approval.
		expect(result.denialContext).toMatchObject({ pathValue: "src/file.txt" });
		expect(result.decision.value).toBe("src/file.txt");
	});

	it("does not resolve relative policy values through an unknown cd", async () => {
		const resolver = makeResolver(makeCheckResult({ state: "deny", matchedPattern: "*" }));
		await describeGate(
			makeTcc({
				input: { command: 'cd "$DIR" && cat src/foo.ts' },
				cwd: "/test/project",
			}),
			resolver,
		);

		expect(resolver.resolve).toHaveBeenCalledWith({
			kind: "access-path",
			surface: "path",
			path: AccessPath.forLiteral("src/foo.ts"),
			agentName: undefined,
		});
	});

	it("binds a current-directory token's session approval to the cwd subtree", async () => {
		const resolver = makeResolver(makeCheckResult({ state: "ask", matchedPattern: "*" }));
		const result = (await describeGate(
			makeTcc({
				input: { command: "cat .env" },
				cwd: "/test/project",
			}),
			resolver,
		)) as GateDescriptor;

		expect(result.decision.value).toBe(".env");
		expect(result.sessionApproval?.surface).toBe("path");
		expect(result.sessionApproval?.representativePattern).toBe("/test/project/*");
	});
});

// Home-relative path characterization (#350) ──────────────────────────────
//
// The parser extracts ~/... tokens from bash commands; the resolver receives
// the raw token and normalizeInput handles expansion. These tests verify the
// gate correctly dispatches ~/... tokens through the deny/ask path.

describe("describeBashPathGate — home-relative paths", () => {
	it("extracts ~/... token and builds descriptor on deny", async () => {
		// node:os is mocked: homedir() returns "/mock/home".
		// cat ~/.ssh/config → token "~/.ssh/config" extracted.
		const resolver = makePathDispatchResolver(
			{
				"/mock/home/.ssh/config": makeCheckResult({
					state: "deny",
					matchedPattern: "~/.ssh/*",
				}),
			},
			makeCheckResult({ state: "allow" }),
		);
		const result = (await describeGate(makeTcc({ input: { command: "cat ~/.ssh/config" } }), resolver)) as GateDescriptor;

		expect(isGateDescriptor(result)).toBe(true);
		expect(result.preCheck?.state).toBe("deny");
		expect(result.denialContext).toMatchObject({
			kind: "bash_path",
			command: "cat ~/.ssh/config",
			pathValue: "~/.ssh/config",
		});
	});

	it("extracts $HOME/... token and builds descriptor on deny", async () => {
		const resolver = makePathDispatchResolver(
			{
				"/mock/home/.ssh/config": makeCheckResult({
					state: "deny",
					matchedPattern: "$HOME/.ssh/*",
				}),
			},
			makeCheckResult({ state: "allow" }),
		);
		const result = (await describeGate(
			makeTcc({ input: { command: "cat $HOME/.ssh/config" } }),
			resolver,
		)) as GateDescriptor;

		expect(isGateDescriptor(result)).toBe(true);
		expect(result.preCheck?.state).toBe("deny");
		expect(result.denialContext).toMatchObject({
			kind: "bash_path",
			pathValue: "$HOME/.ssh/config",
		});
	});
});
