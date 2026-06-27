import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InterruptManager } from "../../src/handlers/interrupt";
import { InterruptHandler } from "../../src/handlers/interrupt";

describe("InterruptHandler", () => {
	let manager: InterruptManager;
	let mockAbortAll: ReturnType<typeof vi.fn<InterruptManager["abortAll"]>>;
	let handler: InterruptHandler;

	beforeEach(() => {
		mockAbortAll = vi.fn(() => 0);
		manager = { abortAll: mockAbortAll };
		handler = new InterruptHandler(manager);
	});

	describe("handleTurnStart", () => {
		it("aborts all subagents when the latched signal fires", () => {
			const controller = new AbortController();
			handler.handleTurnStart({ signal: controller.signal });

			expect(mockAbortAll).not.toHaveBeenCalled();
			controller.abort();
			expect(mockAbortAll).toHaveBeenCalledOnce();
		});

		it("does not abort when the signal never fires", () => {
			const controller = new AbortController();
			handler.handleTurnStart({ signal: controller.signal });
			expect(mockAbortAll).not.toHaveBeenCalled();
		});

		it("latches only one listener across repeated turns with the same signal", () => {
			const controller = new AbortController();
			handler.handleTurnStart({ signal: controller.signal });
			handler.handleTurnStart({ signal: controller.signal });
			handler.handleTurnStart({ signal: controller.signal });

			controller.abort();
			expect(mockAbortAll).toHaveBeenCalledOnce();
		});

		it("re-wires to a new signal and ignores the stale one", () => {
			const first = new AbortController();
			handler.handleTurnStart({ signal: first.signal });

			const second = new AbortController();
			handler.handleTurnStart({ signal: second.signal });

			// The stale signal no longer triggers an abort.
			first.abort();
			expect(mockAbortAll).not.toHaveBeenCalled();

			// The current signal does.
			second.abort();
			expect(mockAbortAll).toHaveBeenCalledOnce();
		});

		it("detaches the previous listener when the signal becomes undefined", () => {
			const controller = new AbortController();
			handler.handleTurnStart({ signal: controller.signal });
			handler.handleTurnStart({ signal: undefined });

			controller.abort();
			expect(mockAbortAll).not.toHaveBeenCalled();
		});

		it("is a no-op when called with an undefined signal", () => {
			expect(() => handler.handleTurnStart({ signal: undefined })).not.toThrow();
			expect(mockAbortAll).not.toHaveBeenCalled();
		});
	});
});
