import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolStartWidget } from "../../src/handlers/tool-start";
import { ToolStartHandler } from "../../src/handlers/tool-start";

describe("ToolStartHandler", () => {
	let widget: ToolStartWidget;
	let mockSetUICtx: ReturnType<typeof vi.fn<ToolStartWidget["setUICtx"]>>;
	let mockOnTurnStart: ReturnType<typeof vi.fn<ToolStartWidget["onTurnStart"]>>;
	let handler: ToolStartHandler;

	beforeEach(() => {
		mockSetUICtx = vi.fn();
		mockOnTurnStart = vi.fn();
		widget = {
			setUICtx: mockSetUICtx,
			onTurnStart: mockOnTurnStart,
		};
		handler = new ToolStartHandler(widget);
	});

	describe("handleToolExecutionStart", () => {
		it("calls setUICtx with the context's ui", () => {
			const ui = { setStatus: vi.fn(), setWidget: vi.fn() };

			handler.handleToolExecutionStart({}, { ui });

			expect(widget.setUICtx).toHaveBeenCalledWith(ui);
		});

		it("calls onTurnStart", () => {
			const ui = { setStatus: vi.fn(), setWidget: vi.fn() };

			handler.handleToolExecutionStart({}, { ui });

			expect(widget.onTurnStart).toHaveBeenCalled();
		});

		it("calls setUICtx before onTurnStart", () => {
			const callOrder: string[] = [];
			mockSetUICtx.mockImplementation(() => {
				callOrder.push("setUICtx");
			});
			mockOnTurnStart.mockImplementation(() => {
				callOrder.push("onTurnStart");
			});

			const ui = { setStatus: vi.fn(), setWidget: vi.fn() };
			handler.handleToolExecutionStart({}, { ui });

			expect(callOrder).toEqual(["setUICtx", "onTurnStart"]);
		});
	});
});
