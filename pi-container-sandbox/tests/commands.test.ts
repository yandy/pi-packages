import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxCommandHandlers } from "../src/commands/sandbox";
import { extractCommandName } from "../src/ops";
import { clearSbx } from "../src/session";
import { mockRuntime, mockSbx } from "./_helpers";

function mockPathApprovals() {
	return {
		list: () => [],
		revoke: () => false,
		add: () => {},
		find: () => undefined,
	};
}

function notifyCtx() {
	const notifications: { msg: string; level: string }[] = [];
	return {
		notifications,
		ui: {
			notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }),
			setStatus: (_key: string, _msg: string) => {},
		},
	};
}

function buildCtx(selectResult?: string) {
	const notifications: { msg: string; level: string }[] = [];
	return {
		notifications,
		ui: {
			notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }),
			setStatus: (_key: string, _msg: string) => {},
			select: async (_title: string, _options: string[]) => selectResult ?? "cn",
		},
	};
}

afterEach(() => clearSbx());

describe("/sandbox stop", () => {
	it("blocks stop when keep is true", async () => {
		const ctx = notifyCtx();
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());
		mockSbx({ keep: true });

		await handlers.stop("", ctx);
		expect(ctx.notifications.some((n) => n.msg.includes("keep/persist"))).toBe(true);
	});

	it("executes shutdown when keep is false", async () => {
		const ctx = notifyCtx();
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

		let shutdownCalled = false;
		const rt = mockRuntime({
			shutdown: async () => {
				shutdownCalled = true;
			},
		});
		mockSbx({ keep: false, runtime: rt });

		await handlers.stop("", ctx);
		expect(shutdownCalled).toBe(true);
		expect(ctx.notifications.some((n) => n.msg.includes("stopped and removed"))).toBe(true);
	});
});

describe("/sandbox build", () => {
	it("shows selection and builds with selected dockerfile", async () => {
		const ctx = buildCtx("cn");
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

		let buildDockerfile = "";
		const rt = mockRuntime({
			buildImage: async (opts) => {
				buildDockerfile = opts.dockerfile;
			},
		});
		mockSbx({ runtime: rt });

		await handlers.build("", ctx);
		expect(buildDockerfile).toBe(resolve(fileURLToPath(import.meta.url), "..", "..", "docker", "cn.Dockerfile"));
	});

	it("shows message when user skips build", async () => {
		const ctx = buildCtx("跳过");
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());
		mockSbx();

		await handlers.build("", ctx);
		expect(ctx.notifications.some((n) => n.msg.includes("跳过"))).toBe(true);
	});

	it("shows error on build failure", async () => {
		const ctx = buildCtx("cn");
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

		const rt = mockRuntime({
			buildImage: async () => {
				throw new Error("build error");
			},
		});
		mockSbx({ runtime: rt });

		await handlers.build("", ctx);
		expect(ctx.notifications.some((n) => n.msg.includes("失败"))).toBe(true);
	});
});

describe("/sandbox exec", () => {
	it("executes command and shows output", async () => {
		const ctx = notifyCtx();
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

		const rt = mockRuntime({
			exec: async () => ({ exitCode: 0, stdout: Buffer.from("hello"), stderr: Buffer.alloc(0) }),
		});
		mockSbx({ runtime: rt });

		await handlers.exec("echo hello", ctx);
		expect(ctx.notifications.some((n) => n.msg.includes("hello"))).toBe(true);
	});

	it("shows error for empty command", async () => {
		const ctx = notifyCtx();
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());
		mockSbx();

		await handlers.exec("", ctx);
		expect(ctx.notifications.some((n) => n.msg.includes("Usage"))).toBe(true);
	});
});

describe("/sandbox keep", () => {
	it("updates config with container name", async () => {
		const ctx = notifyCtx();
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());
		mockSbx({ name: "my-container" });

		await handlers.keep("my-container", ctx);
		expect(ctx.notifications.some((n) => n.msg.includes("saved to sandbox.json"))).toBe(true);
	});
});

describe("host command whitelist (unit level)", () => {
	it("extractCommandName matches hostCommands whitelist check", () => {
		const hostCommands = ["git", "docker"];
		const cmdName = extractCommandName("git status");
		expect(cmdName).toBe("git");
		expect(hostCommands.includes(cmdName!)).toBe(true);
	});

	it("extractCommandName does not match non-whitelisted command", () => {
		const hostCommands = ["git", "docker"];
		const cmdName = extractCommandName("ls -la");
		expect(cmdName).toBe("ls");
		expect(hostCommands.includes(cmdName!)).toBe(false);
	});
});
