import { describe, it, expect } from "vitest";
import { createSandboxCommandHandlers } from "../src/commands/sandbox";
import { setSbx, clearSbx, type SbxSession } from "../src/session";
import type { Runtime } from "../src/runtime";

function mockRuntime(): Runtime {
	return {
		init: async () => {},
		isReady: () => true,
		ensureImage: async () => {},
		rebuildImage: async () => {},
		startContainer: async () => {},
		withReady: async () => {},
		shutdown: async () => {},
		getContainerId: () => "mock-id",
		getWorkRoot: () => "/workspace",
		exec: async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
	};
}

function mockPathApprovals() {
	return {
		list: () => [],
		revoke: () => false,
		add: () => {},
		find: () => undefined,
	};
}

describe("/sandbox stop", () => {
	it("blocks stop when keep is true", async () => {
		const notifications: { msg: string; level: string }[] = [];
		const ctx = { ui: { notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }) } };
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

		const rt = mockRuntime();
		setSbx({
			runtime: rt,
			name: "test-box",
			hostCwd: "/tmp",
			keep: true,
			mounts: [],
			allowedExternalPrefixes: [],
			imageRef: "img:latest",
			config: {} as any,
			isReusable: false,
			isReattached: false,
		});

		await handlers.stop("", ctx);
		expect(notifications.some((n) => n.msg.includes("keep/persist"))).toBe(true);
		clearSbx();
	});

	it("executes shutdown when keep is false", async () => {
		const notifications: { msg: string; level: string }[] = [];
		const ctx = { ui: { notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }) } };
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

		let shutdownCalled = false;
		const rt = mockRuntime();
		rt.shutdown = async () => { shutdownCalled = true; };

		setSbx({
			runtime: rt,
			name: "test-box",
			hostCwd: "/tmp",
			keep: false,
			mounts: [],
			allowedExternalPrefixes: [],
			imageRef: "img:latest",
			config: {} as any,
			isReusable: false,
			isReattached: false,
		});

		await handlers.stop("", ctx);
		expect(shutdownCalled).toBe(true);
		expect(notifications.some((n) => n.msg.includes("stopped and removed"))).toBe(true);
		clearSbx();
	});
});
