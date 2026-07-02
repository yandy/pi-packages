import { describe, it, expect, vi } from "vitest";
import { buildDreamTask, resolveDreamModel, extractSummary, runDream } from "../src/dream";
import type { MemoryConfig } from "../src/config";

const cfg: Pick<MemoryConfig, "dream"> = { dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, model: "auto" } };

describe("buildDreamTask", () => {
	it("includes memory dir + consolidation instructions + line limit", () => {
		const task = buildDreamTask("/mem/abc123", 200);
		expect(task).toContain("/mem/abc123");
		expect(task).toMatch(/deduplicat|consolidat/i);
		expect(task).toContain("200");
	});
});

describe("resolveDreamModel", () => {
	it("returns ctx.model when auto", () => {
		const m = { id: "x", provider: "p" } as any;
		expect(resolveDreamModel({ ...cfg, dream: { ...cfg.dream, model: "auto" } } as any, { model: m } as any)).toBe(m);
	});
	it("resolves explicit provider/id via registry", () => {
		const found = { id: "flash", provider: "deepseek" };
		const registry = { find: vi.fn(() => found) } as any;
		const r = resolveDreamModel({ ...cfg, dream: { ...cfg.dream, model: "deepseek/deepseek-v4-flash" } } as any, { model: {} as any, modelRegistry: registry });
		expect(r).toBe(found);
		expect(registry.find).toHaveBeenCalledWith("deepseek", "deepseek-v4-flash");
	});
	it("returns null when explicit model not found", () => {
		const registry = { find: vi.fn(() => undefined) } as any;
		const r = resolveDreamModel({ ...cfg, dream: { ...cfg.dream, model: "x/y" } } as any, { model: {} as any, modelRegistry: registry });
		expect(r).toBeNull();
	});
});

describe("extractSummary", () => {
	it("returns text of the last assistant message", () => {
		const msgs = [
			{ role: "user", content: "go" },
			{ role: "assistant", content: [{ type: "text", text: "working" }] },
			{ role: "assistant", content: [{ type: "text", text: "merged 3 entries" }] },
		];
		expect(extractSummary(msgs as any)).toBe("merged 3 entries");
	});
	it("returns fallback when no assistant message", () => {
		expect(extractSummary([{ role: "user", content: "x" }] as any)).toBe("Dream completed.");
	});
});

describe("runDream", () => {
	it("passes correct config to createSession and returns summary", async () => {
		const fakeSession = {
			subscribe: () => () => {},
			prompt: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		};
		const createSession = vi.fn().mockResolvedValue({ session: fakeSession });
		const summary = await runDream({ model: { id: "m" } as any, memoryDir: "/mem/x", cwd: "/mem/x", createSession } as any);
		expect(createSession).toHaveBeenCalled();
		const callArg = createSession.mock.calls[0][0];
		expect(callArg.tools).toEqual(["read", "edit", "write"]);
		expect(callArg.cwd).toBe("/mem/x");
		expect(fakeSession.prompt).toHaveBeenCalled();
		expect(fakeSession.dispose).toHaveBeenCalled();
		expect(summary).toBe("done");
	});
	it("disposes on prompt error", async () => {
		const fakeSession = { subscribe: () => () => {}, prompt: vi.fn().mockRejectedValue(new Error("boom")), dispose: vi.fn(), messages: [] };
		const createSession = vi.fn().mockResolvedValue({ session: fakeSession });
		await expect(runDream({ model: { id: "m" } as any, memoryDir: "/mem/x", cwd: "/mem/x", createSession } as any)).rejects.toThrow("boom");
		expect(fakeSession.dispose).toHaveBeenCalled();
	});
});
