import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 隔离 getAgentDir：../index → loadConfig 会读 <agentDir>/coding-tools.json，
// 不 mock 就会依赖开发机上真实的 ~/.pi/agent/coding-tools.json。
// 必须保留 actual 的其余导出（尤其 CONFIG_DIR_NAME，path.resolve 不接受 undefined）。
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return { ...actual, getAgentDir: () => "/nonexistent-agent-dir/agent" };
});

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
	// 项目级 cwd 也必须是临时目录：loadConfig 会读 <cwd>/.pi/coding-tools.json
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "ext-factory-"));
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("does not call action methods during factory load", async () => {
		const pi = makeLoadingPi();

		const mod = await import("../index");
		const factory = mod.default;

		// 如果工厂在加载期间调用了 getActiveTools/setActiveTools，
		// 上面 mock 的抛错会冒泡到这里，导致工厂执行失败
		expect(() => factory(pi as never)).not.toThrow();

		// 验证：将 refreshTools 推迟到了 session_start
		const sessionStartHandlers = pi.handlers.get("session_start");
		expect(sessionStartHandlers).toBeDefined();
		expect(sessionStartHandlers?.length).toBe(1);
	});

	it("refreshTools runs when session_start fires (with initialized runtime)", async () => {
		const pi = makeLoadingPi();

		const mod = await import("../index");
		const factory = mod.default;
		factory(pi as never);

		// 模拟 runtime 初始化完成：action methods 不再抛错；grep 由 pi 自身/其他扩展激活
		pi.getActiveTools.mockReturnValue(["read", "bash", "edit", "write", "grep"]);
		pi.setActiveTools.mockImplementation(() => {});

		const sessionStartHandler = pi.handlers.get("session_start")?.[0];
		if (!sessionStartHandler) throw new Error("expected session_start handler");
		await sessionStartHandler({} as never, { cwd: projectDir } as never);

		// refreshTools 只应管理自定义工具，且不得关闭别人激活的 grep
		expect(pi.setActiveTools).toHaveBeenCalled();
		const activeTools: string[] = pi.setActiveTools.mock.calls[0][0];
		for (const name of ["ast_grep_search", "ast_grep_replace", "lsp_symbols", "lsp_hover", "lsp_navigate"]) {
			expect(activeTools).toContain(name);
		}
		expect(activeTools).toContain("grep");
		expect(activeTools).not.toContain("ls");
		expect(activeTools).not.toContain("find");
	});

	it("registers all five tools", async () => {
		const pi = makeLoadingPi();

		const mod = await import("../index");
		const factory = mod.default;
		factory(pi as never);

		const names = pi.registerTool.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
		expect(names).toContain("ast_grep_search");
		expect(names).toContain("ast_grep_replace");
		expect(names).toContain("lsp_symbols");
		expect(names).toContain("lsp_hover");
		expect(names).toContain("lsp_navigate");
		expect(names).toHaveLength(5);
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
