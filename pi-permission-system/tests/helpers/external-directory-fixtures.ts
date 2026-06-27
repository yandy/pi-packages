/**
 * Shared fixtures for the external-directory handler-pipeline tests.
 *
 * Targets the collapsed external-directory gate (Phase 6 Step 5, #477).
 * Consumed by external-directory-integration.test.ts and
 * external-directory-session-dedup.test.ts.
 */
import { vi } from "vitest";

import { GateDecisionReporter } from "../../src/decision-reporter";
import type { GatePrompter } from "../../src/gate-prompter";
import { GateRunner } from "../../src/handlers/gates/runner";
import { SkillInputGatePipeline } from "../../src/handlers/gates/skill-input-gate-pipeline";
import { ToolCallGatePipeline } from "../../src/handlers/gates/tool-call-gate-pipeline";
import { PermissionGateHandler } from "../../src/handlers/permission-gate-handler";
import type { ScopedPermissionManager } from "../../src/permission-manager";
import type { SessionLogger } from "../../src/session-logger";
import type { PermissionCheckResult, PermissionState } from "../../src/types";
import { wildcardMatch } from "../../src/wildcard-matcher";

import { getDecisionEvents, makeEvents, makeSurfaceCheck, makeToolRegistry } from "../helpers/handler-fixtures";
import { makeRealResolver, makeRealSession } from "../helpers/session-fixtures";

// ── Shared constants ───────────────────────────────────────────────────────

/** Working-directory used by the external-directory handler-pipeline tests. */
export const EXT_DIR_CWD = "/test/project";

/** An external path (outside {@link EXT_DIR_CWD}) used across the test suite. */
export const EXTERNAL_PATH = "/outside/project/file.ts";

/** All path-bearing tools subject to the external-directory gate. */
export const ALL_PATH_BEARING_TOOLS = ["read", "write", "edit", "find", "grep", "ls"];

/** Path-bearing tools where the path is optional (no input → gate is skipped). */
export const OPTIONAL_PATH_TOOLS = ["find", "grep", "ls"];

/** Full tool set used as the default registry in external-directory tests. */
export const ALL_TOOLS = [...ALL_PATH_BEARING_TOOLS, "bash"];

// ── Setup builders ─────────────────────────────────────────────────────────

/**
 * Builds a `checkPermission` mock for external-directory tests.
 *
 * Routes `external_directory` to `externalDirectoryState`, `path` to allow
 * with `source: "special"` (so the cross-cutting path gate is transparent),
 * and every other surface to `toolState` (default: allow).
 */
export function makeExtDirCheck(externalDirectoryState: PermissionState, toolState: PermissionState = "allow") {
	return makeSurfaceCheck(
		{
			external_directory: { state: externalDirectoryState },
			path: { state: "allow", source: "special" },
		},
		{ state: toolState },
	);
}

/** GatePrompter stub that approves with `state: "approved"`. */
export function makeApprovingPrompter(): GatePrompter {
	return {
		canConfirm: vi.fn().mockReturnValue(true),
		prompt: vi.fn<GatePrompter["prompt"]>().mockResolvedValue({ approved: true, state: "approved" }),
	};
}

/**
 * GatePrompter stub that denies.
 *
 * Pass `denialReason` to simulate a user who explains the refusal.
 */
export function makeDenyingPrompter(denialReason?: string): GatePrompter {
	return {
		canConfirm: vi.fn().mockReturnValue(true),
		prompt: vi
			.fn<GatePrompter["prompt"]>()
			.mockResolvedValue(
				denialReason !== undefined
					? { approved: false, state: "denied", denialReason }
					: { approved: false, state: "denied" },
			),
	};
}

/** GatePrompter stub that reports no UI is available (`canConfirm: false`). */
export function makeUnavailablePrompter(): GatePrompter {
	return {
		canConfirm: vi.fn().mockReturnValue(false),
		prompt: vi.fn<GatePrompter["prompt"]>(),
	};
}

// ── Query helpers ──────────────────────────────────────────────────────────

/** Find the `external_directory` decision event from the events mock. */
export function findExtDirDecision(events: ReturnType<typeof makeEvents>) {
	return getDecisionEvents(events).find((d) => d.surface === "external_directory");
}

/** Return the `permission_request.blocked` review-log entries from the logger mock. */
export function blockReviewEntries(logger: SessionLogger) {
	return (logger.review as ReturnType<typeof vi.fn>).mock.calls.filter(
		([eventName]: string[]) => eventName === "permission_request.blocked",
	);
}

// ── Session-dedup wiring ──────────────────────────────────────────────────

/**
 * Installs the session-aware `check(intent)` mock on the permission manager.
 *
 * Returns `ask` for `external_directory` on first access; re-checks recorded
 * session rules on subsequent calls and returns `allow` (source: "session")
 * when a `wildcardMatch` covers the path.
 */
export function makeExtDirDedupCheck(permissionManager: ScopedPermissionManager): void {
	vi.mocked(permissionManager.check).mockImplementation((intent, rules): PermissionCheckResult => {
		const { surface } = intent;
		const pathValue = intent.kind === "path-values" ? (intent.values[0] ?? null) : null;

		if (surface === "external_directory") {
			if (pathValue && rules && rules.length > 0) {
				const match = rules.findLast((r) => r.surface === "external_directory" && wildcardMatch(r.pattern, pathValue));
				if (match) {
					return {
						state: "allow",
						toolName: surface,
						source: "session",
						origin: "session",
						matchedPattern: match.pattern,
					};
				}
			}
			return {
				state: "ask",
				toolName: surface,
				source: "special",
				origin: "global",
			};
		}

		return {
			state: "allow",
			toolName: surface,
			source: "tool",
			origin: "builtin",
		};
	});
}

/** GatePrompter stub that approves for the session (`state: "approved_for_session"`). */
function makeSessionApprovingPrompter(): GatePrompter {
	return {
		canConfirm: vi.fn().mockReturnValue(true),
		prompt: vi.fn<GatePrompter["prompt"]>().mockResolvedValue({ approved: true, state: "approved_for_session" }),
	};
}

/**
 * Builds the fully-wired session-dedup handler with real collaborators.
 *
 * Unlike `makeHandler`, this wires `makeRealSession` + `makeRealResolver`
 * manually so the caller can access the raw `session` for shutdown tests.
 *
 * Returns `{ handler, prompter, session }`.
 */
export function makeDedupWiring(prompter?: GatePrompter) {
	const { session, permissionManager, sessionRules, logger } = makeRealSession();
	const { resolver } = makeRealResolver(permissionManager, sessionRules);
	makeExtDirDedupCheck(permissionManager);
	const events = makeEvents();
	const reporter = new GateDecisionReporter(logger, events);
	const resolvedPrompter: GatePrompter = prompter ?? makeSessionApprovingPrompter();
	const runner = new GateRunner(resolver, sessionRules, resolvedPrompter, reporter);
	const handler = new PermissionGateHandler(
		session,
		makeToolRegistry({
			getAll: vi.fn().mockReturnValue([{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }]),
		}),
		new ToolCallGatePipeline(resolver, session),
		new SkillInputGatePipeline(resolver),
		runner,
	);
	return { handler, prompter: resolvedPrompter, session };
}

/**
 * Builds the session-dedup handler without exposing the raw session.
 *
 * Wraps `makeDedupWiring`; returns `{ handler, prompter }`.
 * Use `makeDedupWiring` when the test also needs `session.shutdown()`.
 */
export function makeDeduplicatingHandler(prompter?: GatePrompter) {
	const { handler, prompter: resolvedPrompter } = makeDedupWiring(prompter);
	return { handler, prompter: resolvedPrompter };
}

// ── Event builders ─────────────────────────────────────────────────────────

/**
 * Builds a tool-call event in the shape that external-directory-session-dedup
 * tests use — `toolName` field (not `name`); both are accepted by
 * `getToolNameFromValue`.
 */
export function makeExtDirToolEvent(toolName: string, path: string, toolCallId = "tc-1") {
	return { type: "tool_call" as const, toolCallId, toolName, input: { path } };
}

/** Builds a bash tool-call event for external-directory session-dedup tests. */
export function makeExtDirBashEvent(command: string, toolCallId = "tc-1") {
	return {
		type: "tool_call" as const,
		toolCallId,
		toolName: "bash",
		input: { command },
	};
}
