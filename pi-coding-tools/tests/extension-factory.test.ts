import { describe, expect, it, vi } from "vitest";

const ACTION_ERROR = new Error(
	"Extension runtime not initialized. Action methods cannot be called during extension loading.",
);

function makeLoadingPi() {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	return {
		handlers,
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)?.push(handler);
		}),
		registerTool: vi.fn<(def: { name: string }) => void>(),
		// 模拟真实 pi：加载期间 action methods 抛错
		getActiveTools: vi.fn<() => string[]>(() => {
			throw ACTION_ERROR;
		}),
		setActiveTools: vi.fn<(_tools: string[]) => void>(() => {
			throw ACTION_ERROR;
		}),
	};
}

describe("extension factory", () => {
	it("does not call action methods during factory load", async () => {
		const pi = makeLoadingPi();

		const mod = await import("../index");
		const factory = mod.default;

		// 如果工厂在加载期间调用了 getActiveTools/setActiveTools，
		// 上面 mock 的抛错会冒泡到这里，导致工厂执行失败
		expect(() => factory(pi as never)).not.toThrow();

		// 验证：将 syncToolsStatus 推迟到了 session_start
		const sessionStartHandlers = pi.handlers.get("session_start");
		expect(sessionStartHandlers).toBeDefined();
		expect(sessionStartHandlers?.length).toBe(1);
	});

	it("syncToolsStatus runs when session_start fires (with initialized runtime)", async () => {
		const pi = makeLoadingPi();

		const mod = await import("../index");
		const factory = mod.default;
		factory(pi as never);

		// 模拟 runtime 初始化完成：action methods 不再抛错
		pi.getActiveTools.mockReturnValue(["read", "bash", "edit", "write"]);
		pi.setActiveTools.mockImplementation(() => {});

		const sessionStartHandler = pi.handlers.get("session_start")?.[0];
		await sessionStartHandler();

		// syncToolsStatus 应该已经启用了配置中的工具
		expect(pi.setActiveTools).toHaveBeenCalled();
		const activeTools: string[] = pi.setActiveTools.mock.calls[0][0];
		for (const name of ["ls", "find", "grep", "ast_grep_search", "lsp_symbols", "lsp_hover", "lsp_navigate"]) {
			expect(activeTools).toContain(name);
		}
	});

	it("registers all four tools", async () => {
		const pi = makeLoadingPi();

		const mod = await import("../index");
		const factory = mod.default;
		factory(pi as never);

		const names = pi.registerTool.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
		expect(names).toContain("ast_grep_search");
		expect(names).toContain("lsp_symbols");
		expect(names).toContain("lsp_hover");
		expect(names).toContain("lsp_navigate");
	});

	it("registers session_shutdown handler", async () => {
		const pi = makeLoadingPi();

		const mod = await import("../index");
		const factory = mod.default;
		factory(pi as never);

		const shutdownHandlers = pi.handlers.get("session_shutdown");
		expect(shutdownHandlers).toBeDefined();
		expect(shutdownHandlers?.length).toBe(1);
	});
});
