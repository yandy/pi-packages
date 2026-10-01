import { afterEach, describe, expect, it, vi } from "vitest";
import { createPermissionCommand, createPermissionState } from "../src/permission";

function makeCtx() {
	return { ui: { notify: vi.fn() } };
}

afterEach(async () => {
	// processPermissionState 现在是进程级 globalThis 单例：跨用例/跨文件必须复位
	const { resetPermissionStateForTests } = await import("../src/permission");
	resetPermissionStateForTests();
	vi.resetModules();
});

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

describe("processPermissionState 跨模块实例共享（异 cwd 子会话 / reload 会重新 import 扩展）", () => {
	it("模块被重新 import 后仍是同一对象，且能看到已设的覆盖", async () => {
		const { processPermissionState } = await import("../src/permission");
		processPermissionState.override = "danger-full-access";

		// 模拟宿主的扩展模块缓存失效：loader 以 (cwd, generation) 为令牌，令牌变化即
		// clearExtensionCache() + createJiti({ moduleCache: false }) 重新 import
		//（pi dist/core/extensions/loader.js）；vitest 的 resetModules 等价于此。
		vi.resetModules();
		const { processPermissionState: reimported } = await import("../src/permission");

		expect(reimported).toBe(processPermissionState); // 必须是同一个 globalThis 单例
		expect(reimported.override).toBe("danger-full-access"); // 父会话设的覆盖对“新 import 的实例”可见
	});

	it("resetPermissionStateForTests 清掉全局槽位，下一次 import 回到默认状态", async () => {
		const mod = await import("../src/permission");
		mod.processPermissionState.override = "read-only";
		mod.resetPermissionStateForTests();

		vi.resetModules();
		const { processPermissionState: fresh } = await import("../src/permission");

		expect(fresh).not.toBe(mod.processPermissionState); // 旧引用已脱离全局槽位
		expect(fresh.override).toBeNull();
	});
});
