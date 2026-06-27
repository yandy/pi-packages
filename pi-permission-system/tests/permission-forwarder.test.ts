import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_EXTENSION_CONFIG } from "../src/extension-config";
import {
	type ForwarderContext,
	PermissionForwarder,
	type PermissionForwarderDeps,
} from "../src/forwarded-permissions/permission-forwarder";
import { createPermissionForwardingLocation } from "../src/permission-forwarding";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<PermissionForwarderDeps> = {}): PermissionForwarderDeps {
	return {
		forwardingDir: "/tmp/forwarding",
		subagentSessionsDir: "/tmp/subagents",
		logger: { review: vi.fn(), debug: vi.fn() },
		requestPermissionDecisionFromUi: vi.fn().mockResolvedValue({ approved: true, state: "approved" as const }),
		config: { current: () => ({ ...DEFAULT_EXTENSION_CONFIG }) },
		...overrides,
	};
}

function makeCtx(
	overrides: {
		hasUI?: boolean;
		ui?: ForwarderContext["ui"];
		sessionManager?: Partial<ForwarderContext["sessionManager"]>;
	} = {},
): ForwarderContext {
	return {
		hasUI: overrides.hasUI ?? false,
		ui: overrides.ui ?? { select: vi.fn(), input: vi.fn() },
		sessionManager: {
			getSessionId: vi.fn(() => ""),
			getSessionDir: vi.fn(() => ""),
			getEntries: vi.fn(() => []),
			...overrides.sessionManager,
		},
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
});

// ── requestApproval ───────────────────────────────────────────────────────

describe("requestApproval — UI fast path", () => {
	test("calls requestPermissionDecisionFromUi but does not emit a UI prompt event (the prompter does)", async () => {
		const events = {
			emit: vi.fn(),
			on: vi.fn().mockReturnValue(() => undefined),
		};
		const requestPermissionDecisionFromUi = vi.fn().mockResolvedValue({ approved: true, state: "approved" as const });

		const forwarder = new PermissionForwarder(makeDeps({ events, requestPermissionDecisionFromUi }));

		await forwarder.requestApproval(makeCtx({ hasUI: true }), "Allow git push?");

		expect(requestPermissionDecisionFromUi).toHaveBeenCalled();
		expect(events.emit).not.toHaveBeenCalledWith("permissions:ui_prompt", expect.anything());
	});
});

describe("requestApproval — non-UI, non-subagent path", () => {
	test("returns denied without showing a dialog or emitting when there is no active UI", async () => {
		const events = {
			emit: vi.fn(),
			on: vi.fn().mockReturnValue(() => undefined),
		};
		const requestPermissionDecisionFromUi = vi.fn();

		const forwarder = new PermissionForwarder(makeDeps({ events, requestPermissionDecisionFromUi }));

		const result = await forwarder.requestApproval(makeCtx({ hasUI: false }), "Allow git push?");

		expect(result).toEqual({ approved: false, state: "denied" });
		expect(events.emit).not.toHaveBeenCalledWith("permissions:ui_prompt", expect.anything());
		expect(requestPermissionDecisionFromUi).not.toHaveBeenCalled();
	});
});

// ── processInbox ──────────────────────────────────────────────────────────

describe("processInbox", () => {
	test("emits a UI prompt event before showing a forwarded permission dialog", async () => {
		const root = mkdtempSync(join(tmpdir(), "permission-forwarding-"));
		try {
			const forwardingDir = join(root, "forwarding");
			const location = createPermissionForwardingLocation(forwardingDir, "parent-session");
			mkdirSync(location.requestsDir, { recursive: true });
			mkdirSync(location.responsesDir, { recursive: true });
			writeFileSync(
				join(location.requestsDir, "req-forwarded.json"),
				JSON.stringify({
					id: "req-forwarded",
					createdAt: Date.now(),
					requesterSessionId: "child-session",
					targetSessionId: "parent-session",
					requesterAgentName: "Explore",
					message: "Allow git push?",
				}),
				"utf-8",
			);

			const events = {
				emit: vi.fn(),
				on: vi.fn().mockReturnValue(() => undefined),
			};
			const requestPermissionDecisionFromUi = vi.fn().mockResolvedValue({ approved: true, state: "approved" as const });

			const forwarder = new PermissionForwarder(
				makeDeps({
					forwardingDir,
					events,
					requestPermissionDecisionFromUi,
				}),
			);

			await forwarder.processInbox(
				makeCtx({
					hasUI: true,
					sessionManager: {
						getSessionId: vi.fn(() => "parent-session"),
					},
				}),
			);

			expect(events.emit).toHaveBeenCalledWith(
				"permissions:ui_prompt",
				expect.objectContaining({
					requestId: "req-forwarded",
					source: "tool_call",
					surface: null,
					value: null,
					agentName: "Explore",
					message: expect.stringContaining("Allow git push?"),
					forwarding: {
						requesterAgentName: "Explore",
						requesterSessionId: "child-session",
					},
				}),
			);
			expect(requestPermissionDecisionFromUi).toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("emits a non-degraded UI prompt event when the request carries display fields", async () => {
		const root = mkdtempSync(join(tmpdir(), "permission-forwarding-"));
		try {
			const forwardingDir = join(root, "forwarding");
			const location = createPermissionForwardingLocation(forwardingDir, "parent-session");
			mkdirSync(location.requestsDir, { recursive: true });
			mkdirSync(location.responsesDir, { recursive: true });
			writeFileSync(
				join(location.requestsDir, "req-forwarded-rich.json"),
				JSON.stringify({
					id: "req-forwarded-rich",
					createdAt: Date.now(),
					requesterSessionId: "child-session",
					targetSessionId: "parent-session",
					requesterAgentName: "Explore",
					message: "Allow git push?",
					source: "tool_call",
					surface: "bash",
					value: "git push",
				}),
				"utf-8",
			);

			const events = {
				emit: vi.fn(),
				on: vi.fn().mockReturnValue(() => undefined),
			};
			const requestPermissionDecisionFromUi = vi.fn().mockResolvedValue({ approved: true, state: "approved" as const });

			const forwarder = new PermissionForwarder(
				makeDeps({
					forwardingDir,
					events,
					requestPermissionDecisionFromUi,
				}),
			);

			await forwarder.processInbox(
				makeCtx({
					hasUI: true,
					sessionManager: {
						getSessionId: vi.fn(() => "parent-session"),
					},
				}),
			);

			expect(events.emit).toHaveBeenCalledWith(
				"permissions:ui_prompt",
				expect.objectContaining({
					requestId: "req-forwarded-rich",
					source: "tool_call",
					surface: "bash",
					value: "git push",
					agentName: "Explore",
					message: expect.stringContaining("Allow git push?"),
					forwarding: {
						requesterAgentName: "Explore",
						requesterSessionId: "child-session",
					},
				}),
			);
			expect(requestPermissionDecisionFromUi).toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not emit a UI prompt event when forwarded permission auto-approves", async () => {
		const root = mkdtempSync(join(tmpdir(), "permission-forwarding-"));
		try {
			const forwardingDir = join(root, "forwarding");
			const location = createPermissionForwardingLocation(forwardingDir, "parent-session");
			mkdirSync(location.requestsDir, { recursive: true });
			mkdirSync(location.responsesDir, { recursive: true });
			writeFileSync(
				join(location.requestsDir, "req-forwarded-auto.json"),
				JSON.stringify({
					id: "req-forwarded-auto",
					createdAt: Date.now(),
					requesterSessionId: "child-session",
					targetSessionId: "parent-session",
					requesterAgentName: "Explore",
					message: "Allow git push?",
				}),
				"utf-8",
			);

			const events = {
				emit: vi.fn(),
				on: vi.fn().mockReturnValue(() => undefined),
			};
			const requestPermissionDecisionFromUi = vi.fn();

			const forwarder = new PermissionForwarder(
				makeDeps({
					forwardingDir,
					events,
					requestPermissionDecisionFromUi,
					config: {
						current: () => ({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
					},
				}),
			);

			await forwarder.processInbox(
				makeCtx({
					hasUI: true,
					sessionManager: {
						getSessionId: vi.fn(() => "parent-session"),
					},
				}),
			);

			expect(events.emit).not.toHaveBeenCalledWith("permissions:ui_prompt", expect.anything());
			expect(requestPermissionDecisionFromUi).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("recreates a missing responses/ directory and still writes the response", async () => {
		const root = mkdtempSync(join(tmpdir(), "permission-forwarding-"));
		try {
			const forwardingDir = join(root, "forwarding");
			const location = createPermissionForwardingLocation(forwardingDir, "parent-session");
			// Simulate the race: requests/ exists with a pending file, but
			// responses/ was removed by a concurrent cleanup pass.
			mkdirSync(location.requestsDir, { recursive: true });
			// Deliberately do NOT create location.responsesDir.
			writeFileSync(
				join(location.requestsDir, "req-race.json"),
				JSON.stringify({
					id: "req-race",
					createdAt: Date.now(),
					requesterSessionId: "child-session",
					targetSessionId: "parent-session",
					requesterAgentName: "Explore",
					message: "Allow read?",
				}),
				"utf-8",
			);

			const logger = { review: vi.fn(), debug: vi.fn() };
			const requestPermissionDecisionFromUi = vi.fn().mockResolvedValue({ approved: true, state: "approved" as const });

			const forwarder = new PermissionForwarder(
				makeDeps({
					forwardingDir,
					logger,
					requestPermissionDecisionFromUi,
				}),
			);

			await forwarder.processInbox(
				makeCtx({
					hasUI: true,
					sessionManager: {
						getSessionId: vi.fn(() => "parent-session"),
					},
				}),
			);

			// processInbox must have recreated responses/ and written a response
			// file — no permission_forwarding.error should have been logged.
			expect(logger.review).not.toHaveBeenCalledWith("permission_forwarding.error", expect.anything());
			expect(requestPermissionDecisionFromUi).toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
