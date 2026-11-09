import { describe, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { Terminal } from "@earendil-works/pi-tui";

/**
 * Real-stack integration test: no vi.mock — the actual pi-tui differential
 * renderer, the actual compositeOverlays slicing (which truncates overlays at
 * maxHeight = 85% of terminal rows), the real Text/Markdown/Spacer components
 * and the real keybinding parser all run. A fake Terminal captures written
 * frames so the rendered output can be asserted after ANSI stripping.
 */

class FakeTerminal implements Terminal {
	private readonly rowCount: number;
	private readonly columnCount: number;
	public buffer = "";
	constructor(rows: number, columns: number) {
		this.rowCount = rows;
		this.columnCount = columns;
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.buffer += data;
	}
	get columns(): number {
		return this.columnCount;
	}
	get rows(): number {
		return this.rowCount;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

const ANSI_PATTERN = /\[[0-9;:?]*[a-zA-Z]|\][^\x07]*\x07/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

async function setupOverlay(
	params: Record<string, unknown>,
	rows = 24,
): Promise<{
	terminal: FakeTerminal;
	tui: TUI;
	component: any;
	frame: () => Promise<string>;
	cleanup: () => Promise<void>;
}> {
	initTheme(undefined, false);

	const terminal = new FakeTerminal(rows, 100);
	const tui = new TUI(terminal);
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS as any);

	const { default: registerExtension } = await import("../index");
	let registeredTool: any;
	registerExtension({
		registerTool: (tool: any) => {
			registeredTool = tool;
		},
		events: { emit: () => {} },
	} as any);

	let resolveCustom: (value: any) => void = () => {};
	const customPromise = new Promise<any>((resolve) => {
		resolveCustom = resolve;
	});

	let component: any;
	// Fire execute without awaiting: the dialog stays "open" (custom() never
	// resolves) while the test drives the overlay directly.
	const executePromise = registeredTool.execute("real-stack-test", params, undefined, undefined, {
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				// The extension factory only reads theme.fg/bold from this
				// argument; identity keeps assertions ANSI-free while the
				// context still renders through the REAL Markdown component.
				const identityTheme = {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				};
				component = factory(tui, identityTheme, keybindings, () => {});
				return customPromise;
			},
		},
	});

	for (let i = 0; i < 200 && !component; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	if (!component) throw new Error("component was not created");

	const handle = tui.showOverlay(component, {
		anchor: "center",
		width: "92%",
		minWidth: 40,
		maxHeight: "85%",
		margin: 1,
	} as any);

	const frame = async (): Promise<string> => {
		terminal.buffer = "";
		tui.requestRender(true);
		await new Promise((resolve) => setTimeout(resolve, 50));
		return stripAnsi(terminal.buffer);
	};

	return {
		terminal,
		tui,
		component,
		frame,
		cleanup: async () => {
			handle.hide();
			tui.stop();
			resolveCustom(null); // let execute() finish as cancelled
			await executePromise.catch(() => {});
		},
	};
}

const LONG_CONTEXT = Array.from({ length: 40 }, (_, i) => `ctx line ${String(i + 1).padStart(2, "0")}`).join("\n");

describe("ask_user overlay (real pi-tui pipeline)", () => {
	it("keeps options, help and borders visible when the context is long", async () => {
		const harness = await setupOverlay({ question: "Pick one", context: LONG_CONTEXT, options: ["Alpha", "Beta"] });
		try {
			const first = await harness.frame();

			expect(first).toContain("→ 1. Alpha");
			expect(first).toContain("2. Beta");
			expect(first).toContain("cancel");
			expect(first).toContain("Pick one");
			expect(first).toContain("Context:");
			expect(/↓ \d+ lines? below/.test(first)).toBe(true);
			// Before the fix the overlay was sliced at maxHeight: the bottom
			// border row never reached the terminal.
			expect(first).toContain("╰");
		} finally {
			await harness.cleanup();
		}
	}, 20000);

	it("scrolls the context viewport with real pageUp/pageDown sequences", async () => {
		const harness = await setupOverlay({ question: "Pick one", context: LONG_CONTEXT, options: ["Alpha", "Beta"] });
		try {
			await harness.frame();

			harness.tui.handleInput("[6~"); // pageDown
			const scrolled = await harness.frame();
			expect(/↑ \d+ lines? above/.test(scrolled)).toBe(true);
			expect(scrolled).not.toContain("Pick one");
			expect(scrolled).toContain("→ 1. Alpha");

			harness.tui.handleInput("[5~"); // pageUp
			const back = await harness.frame();
			expect(back).toContain("Pick one");
		} finally {
			await harness.cleanup();
		}
	}, 20000);

	it("clamps a multi-select list within the overlay budget", async () => {
		const options = Array.from({ length: 30 }, (_, i) => ({
			title: `Option ${String(i + 1).padStart(2, "0")}`,
			description: `Description for option ${String(i + 1).padStart(2, "0")} with enough words to wrap onto extra lines at moderate widths`,
		}));
		const harness = await setupOverlay({ question: "Pick several", options, allowMultiple: true });
		try {
			const first = await harness.frame();

			expect(first).toContain("Option 01");
			expect(first).toContain("cancel");
			expect(first).toContain("╰");
		} finally {
			await harness.cleanup();
		}
	}, 20000);
});
