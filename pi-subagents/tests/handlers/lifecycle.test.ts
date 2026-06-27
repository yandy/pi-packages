import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleManager, LifecycleRuntime } from "../../src/handlers/lifecycle";
import { SessionLifecycleHandler } from "../../src/handlers/lifecycle";
import type { EvictedSubagent } from "../../src/lifecycle/subagent-manager";

describe("SessionLifecycleHandler", () => {
	let runtime: LifecycleRuntime;
	let manager: LifecycleManager;
	let mockSetSessionContext: ReturnType<typeof vi.fn<LifecycleRuntime["setSessionContext"]>>;
	let mockClearSessionContext: ReturnType<typeof vi.fn<LifecycleRuntime["clearSessionContext"]>>;
	let mockClearCompleted: ReturnType<typeof vi.fn<LifecycleManager["clearCompleted"]>>;
	let mockAbortAll: ReturnType<typeof vi.fn<LifecycleManager["abortAll"]>>;
	let mockDispose: ReturnType<typeof vi.fn<LifecycleManager["dispose"]>>;
	let mockRestoreEvicted: ReturnType<typeof vi.fn<LifecycleManager["restoreEvicted"]>>;
	let mockDisposeNotifications: ReturnType<typeof vi.fn<() => void>>;
	let mockUnpublishService: ReturnType<typeof vi.fn<() => void>>;
	let mockRecoverEvicted: ReturnType<typeof vi.fn<(parentSessionFile: string | undefined) => EvictedSubagent[]>>;
	let handler: SessionLifecycleHandler;

	beforeEach(() => {
		mockSetSessionContext = vi.fn();
		mockClearSessionContext = vi.fn();
		mockClearCompleted = vi.fn();
		mockAbortAll = vi.fn();
		mockDispose = vi.fn();
		mockRestoreEvicted = vi.fn();
		mockDisposeNotifications = vi.fn();
		mockUnpublishService = vi.fn();
		mockRecoverEvicted = vi.fn(() => []);

		runtime = {
			setSessionContext: mockSetSessionContext,
			clearSessionContext: mockClearSessionContext,
		};
		manager = {
			clearCompleted: mockClearCompleted,
			abortAll: mockAbortAll,
			dispose: mockDispose,
			restoreEvicted: mockRestoreEvicted,
		};

		handler = new SessionLifecycleHandler(
			runtime,
			manager,
			mockDisposeNotifications,
			mockUnpublishService,
			mockRecoverEvicted,
		);
	});

	describe("handleSessionStart", () => {
		it("sets session context and clears completed agents", () => {
			const ctx = { cwd: "/some/path" };

			handler.handleSessionStart({}, ctx);

			expect(runtime.setSessionContext).toHaveBeenCalledWith(ctx);
			expect(manager.clearCompleted).toHaveBeenCalled();
		});

		it("sets context before clearing completed", () => {
			const callOrder: string[] = [];
			mockSetSessionContext.mockImplementation(() => {
				callOrder.push("setSessionContext");
			});
			mockClearCompleted.mockImplementation(() => {
				callOrder.push("clearCompleted");
			});

			handler.handleSessionStart({}, {});

			expect(callOrder).toEqual(["setSessionContext", "clearCompleted"]);
		});

		it("recovers evicted subagent descriptors from the parent session file and restores them", () => {
			const recovered: EvictedSubagent[] = [
				{
					id: "r1",
					type: "Explore",
					description: "old task",
					status: "completed",
					startedAt: 1000,
					completedAt: 4000,
					toolUses: 5,
					outputFile: "/tasks/r1.jsonl",
				},
			];
			mockRecoverEvicted.mockReturnValue(recovered);
			const ctx = { cwd: "/proj", sessionManager: { getSessionFile: () => "/parent.jsonl" } };

			handler.handleSessionStart({}, ctx);

			expect(mockRecoverEvicted).toHaveBeenCalledWith("/parent.jsonl");
			expect(manager.restoreEvicted).toHaveBeenCalledWith(recovered);
		});

		it("restores an empty list when the session is not persisted", () => {
			const ctx = { cwd: "/proj", sessionManager: { getSessionFile: () => undefined } };

			handler.handleSessionStart({}, ctx);

			expect(mockRecoverEvicted).toHaveBeenCalledWith(undefined);
			expect(manager.restoreEvicted).toHaveBeenCalledWith([]);
		});
	});

	describe("handleSessionBeforeSwitch", () => {
		it("clears completed agents", () => {
			handler.handleSessionBeforeSwitch();

			expect(manager.clearCompleted).toHaveBeenCalled();
		});
	});

	describe("handleSessionShutdown", () => {
		it("calls all cleanup steps", async () => {
			await handler.handleSessionShutdown();

			expect(mockUnpublishService).toHaveBeenCalled();
			expect(mockClearSessionContext).toHaveBeenCalled();
			expect(mockAbortAll).toHaveBeenCalled();
			expect(mockDisposeNotifications).toHaveBeenCalled();
			expect(mockDispose).toHaveBeenCalled();
		});

		it("calls cleanup in correct order", async () => {
			const callOrder: string[] = [];
			mockUnpublishService.mockImplementation(() => {
				callOrder.push("unpublishService");
			});
			mockClearSessionContext.mockImplementation(() => {
				callOrder.push("clearSessionContext");
			});
			mockAbortAll.mockImplementation(() => {
				callOrder.push("abortAll");
			});
			mockDisposeNotifications.mockImplementation(() => {
				callOrder.push("disposeNotifications");
			});
			mockDispose.mockImplementation(() => {
				callOrder.push("dispose");
			});

			await handler.handleSessionShutdown();

			expect(callOrder).toEqual([
				"unpublishService",
				"clearSessionContext",
				"abortAll",
				"disposeNotifications",
				"dispose",
			]);
		});
	});
});
