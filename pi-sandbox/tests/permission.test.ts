import { describe, expect, it, vi } from "vitest";
import { createPermissionCommand, createPermissionState } from "../src/permission";

function makeCtx() {
	return { ui: { notify: vi.fn() } };
}

describe("createPermissionCommand", () => {
	it("no args: notifies the status text (describeStatus gets \"\" when ctx has no cwd)", async () => {
		const state = createPermissionState();
		const describeStatus = vi.fn(() => "STATUS-BLOCK");
		const cmd = createPermissionCommand({ state, describeStatus });
		const ctx = makeCtx();
		await cmd.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("STATUS-BLOCK", "info");
		expect(describeStatus).toHaveBeenCalledWith(""); // C2：无 cwd 时空串，由 index 回落 activate cwd
		expect(state.override).toBeNull();
	});
	it("no args: passes the command-session ctx.cwd through to describeStatus (C2)", async () => {
		const describeStatus = vi.fn(() => "S");
		const cmd = createPermissionCommand({ state: createPermissionState(), describeStatus });
		const ctx = { ...makeCtx(), cwd: "/some/session/cwd" };
		await cmd.handler("", ctx);
		expect(describeStatus).toHaveBeenCalledWith("/some/session/cwd");
	});
	it("valid mode: sets the process-level override", async () => {
		const state = createPermissionState();
		const cmd = createPermissionCommand({ state, describeStatus: () => "" });
		const ctx = makeCtx();
		await cmd.handler("danger-full-access", ctx);
		expect(state.override).toBe("danger-full-access");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("danger-full-access"), "info");
	});
	it("invalid mode: error notify listing the three modes, override untouched", async () => {
		const state = createPermissionState();
		const cmd = createPermissionCommand({ state, describeStatus: () => "" });
		const ctx = makeCtx();
		await cmd.handler("yolo", ctx);
		expect(state.override).toBeNull();
		const [msg, level] = ctx.ui.notify.mock.calls[0];
		expect(level).toBe("error");
		expect(msg).toContain("read-only");
		expect(msg).toContain("workspace-write");
		expect(msg).toContain("danger-full-access");
	});
	it("argument completions filter by prefix and carry value+label", () => {
		const cmd = createPermissionCommand({ state: createPermissionState(), describeStatus: () => "" });
		expect(cmd.getArgumentCompletions("w")).toEqual([{ value: "workspace-write", label: "workspace-write" }]);
		expect(cmd.getArgumentCompletions("")).toHaveLength(3);
	});
});
