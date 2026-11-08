import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — layout-faithful versions of the pi-tui primitives.
//
// index.test.ts mocks collapse Text/wrapping to single lines, which is fine
// for interaction tests but useless for layout: this suite needs wrapping,
// padding and line counting that behave like the real components so the
// overlay height budget can be asserted against rendered output.
// ---------------------------------------------------------------------------
vi.mock("@earendil-works/pi-coding-agent", () => ({
	// Undefined → AskComponent falls back to plain Text rendering for the
	// context block, so assertions can work on plain strings.
	getMarkdownTheme: () => undefined,
}));

vi.mock("node:os", () => ({
	homedir: () => "/home/testuser",
}));

let fakeFiles: Record<string, string> = {};
vi.mock("node:fs", () => ({
	existsSync: (path: string) => path in fakeFiles,
	readFileSync: (path: string) => fakeFiles[path] ?? "",
}));

vi.mock("typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		String: (value?: unknown) => value,
		Optional: (value: unknown) => value,
		Array: (value: unknown) => value,
		Union: (value: unknown) => value,
		Boolean: (value?: unknown) => value,
		Number: (value?: unknown) => value,
	},
}));

vi.mock("@earendil-works/pi-tui", () => {
	// Word-wrap that mirrors wrapTextWithAnsi for plain ASCII text.
	const wrap = (text: string, width: number): string[] => {
		const out: string[] = [];
		for (const paragraph of text.split("\n")) {
			if (!paragraph.trim()) {
				out.push("");
				continue;
			}
			let current = "";
			for (const word of paragraph.split(" ")) {
				if (!current) {
					current = word;
					continue;
				}
				if (current.length + 1 + word.length <= width) {
					current = `${current} ${word}`;
				} else {
					out.push(current);
					current = word;
				}
			}
			if (current) out.push(current);
		}
		return out.length > 0 ? out : [""];
	};

	class MockText {
		protected text: string;
		protected paddingX: number;
		protected paddingY: number;
		constructor(text = "", paddingX = 1, paddingY = 0) {
			this.text = text;
			this.paddingX = paddingX;
			this.paddingY = paddingY;
		}
		setText(text: string) {
			this.text = text;
		}
		render(width: number): string[] {
			if (!this.text || this.text.trim() === "") return [];
			const contentWidth = Math.max(1, width - this.paddingX * 2);
			const body = wrap(this.text, contentWidth).map((line) => {
				const padded = " ".repeat(this.paddingX) + line;
				return padded + " ".repeat(Math.max(0, width - padded.length));
			});
			const pad = " ".repeat(width);
			return [...Array.from({ length: this.paddingY }, () => pad), ...body];
		}
	}

	class Markdown extends MockText {}

	class Spacer {
		constructor(private lines: number) {}
		render(width: number): string[] {
			return Array.from({ length: this.lines }, () => " ".repeat(width));
		}
	}

	class MockContainer {
		children: unknown[] = [];
		addChild(component: unknown) {
			this.children.push(component);
		}
		removeChild(component: unknown) {
			const index = this.children.indexOf(component);
			if (index !== -1) this.children.splice(index, 1);
		}
		clear() {
			this.children = [];
		}
		invalidate() {
			for (const child of this.children as Array<{ invalidate?: () => void }>) {
				child.invalidate?.();
			}
		}
		render(width: number): string[] {
			return (this.children as Array<{ render: (w: number) => string[] }>).flatMap((child) =>
				child.render(width),
			);
		}
	}

	const editorInputs: string[] = [];
	let editorText = "";

	class MockEditor {
		disableSubmit = false;
		onSubmit?: (text: string) => void;
		constructor(_tui: unknown, _theme: unknown) {}
		handleInput(data: string) {
			editorInputs.push(data);
			if (data === "enter") this.onSubmit?.(editorText);
		}
		getText() {
			return editorText;
		}
		setText(text = "") {
			editorText = text;
		}
		render(width: number): string[] {
			// Fixed 7-line editor (border + 5 body + border), independent of width.
			const border = "─".repeat(Math.max(0, width - 2));
			return [
				`┌${border}┐`,
				"editor body line 1",
				"editor body line 2",
				"editor body line 3",
				"editor body line 4",
				"editor body line 5",
				`└${border}┘`,
			];
		}
	}

	return {
		Container: MockContainer,
		Editor: MockEditor,
		Key: {
			escape: "escape",
			enter: "enter",
			up: "up",
			down: "down",
			space: "space",
			backspace: "backspace",
			tab: "tab",
			pageUp: "pageUp",
			pageDown: "pageDown",
			ctrl: (key: string) => `ctrl+${key}`,
			alt: (key: string) => `alt+${key}`,
			shift: (key: string) => `shift+${key}`,
		},
		Markdown,
		matchesKey: (data: string, key: string) => data === key,
		isKeyRelease: () => false,
		Spacer,
		Text: MockText,
		truncateToWidth: (text: string, width: number, _marker = "…", pad = false) => {
			if (text.length <= width) {
				return pad ? text + " ".repeat(width - text.length) : text;
			}
			return text.slice(0, width);
		},
		wrapTextWithAnsi: wrap,
		decodeKittyPrintable: (data: string) => (data.length === 1 ? data : undefined),
		fuzzyFilter: <T>(items: T[], query: string, getText: (item: T) => string) => {
			const normalized = query.trim().toLowerCase();
			if (!normalized) return items;
			return items.filter((item) => getText(item).toLowerCase().includes(normalized));
		},
	};
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function createKeybindings() {
	const bindings: Record<string, string[]> = {
		"tui.input.submit": ["enter"],
		"tui.input.newLine": ["shift+enter"],
		"tui.select.confirm": ["enter"],
		"tui.select.cancel": ["escape", "ctrl+c"],
		"tui.select.up": ["up"],
		"tui.select.down": ["down"],
		"tui.editor.deleteCharBackward": ["backspace"],
	};
	return {
		matches(data: string, keybinding: string) {
			return (bindings[keybinding] ?? []).includes(data);
		},
		getKeys(keybinding: string) {
			return bindings[keybinding] ?? [];
		},
	};
}

async function buildAskComponent(params: Record<string, unknown>, rows = 24): Promise<any> {
	const { default: register } = await import("../index");
	let tool: any;
	register({
		registerTool: (definition: any) => {
			tool = definition;
		},
		events: { emit: () => {} },
	} as any);

	let component: any;
	await tool.execute("layout-test", params, undefined, undefined, {
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				component = factory({ requestRender() {}, terminal: { rows } }, createTheme(), createKeybindings(), () => {});
				return null;
			},
		},
	});
	if (!component) throw new Error("component was not created");
	return component;
}

/** 40-line context with zero-padded, uniquely-matchable line markers. */
const LONG_CONTEXT = Array.from({ length: 40 }, (_, i) => `ctx line ${String(i + 1).padStart(2, "0")}`).join("\n");

/** Overlay maxHeight for a given terminal height: min(floor(rows * 0.85), rows - 2). */
function overlayMaxHeight(rows: number): number {
	return Math.min(Math.floor(rows * 0.85), rows - 2);
}

afterEach(() => {
	fakeFiles = {};
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ask_user overlay height budget", () => {
	it("clamps total height so options and help stay visible with a long context", async () => {
		const component = await buildAskComponent(
			{ question: "Pick one", context: LONG_CONTEXT, options: ["Alpha", "Beta"] },
			24,
		);
		const lines = component.render(100) as string[];

		// 24 rows → overlay maxHeight = min(20, 22) = 20
		expect(lines.length).toBeLessThanOrEqual(20);
		const text = lines.join("\n");
		expect(text).toContain("→ 1. Alpha");
		expect(text).toContain("cancel");
	});

	it("shows a scroll indicator when the context is clamped", async () => {
		const component = await buildAskComponent(
			{ question: "Pick one", context: LONG_CONTEXT, options: ["Alpha", "Beta"] },
			24,
		);
		const text = (component.render(100) as string[]).join("\n");

		expect(text).toMatch(/↓ \d+ lines? below/);
	});

	it("scrolls the context with pageUp/pageDown", async () => {
		const component = await buildAskComponent(
			{ question: "Pick one", context: LONG_CONTEXT, options: ["Alpha", "Beta"] },
			24,
		);
		component.render(100);
		// Initial window starts at the top of the header content (question line).
		expect((component.render(100) as string[]).join("\n")).toContain("Pick one");

		component.handleInput("pageDown");
		const scrolled = (component.render(100) as string[]).join("\n");
		expect(scrolled).toMatch(/↑ \d+ lines? above/);
		expect(scrolled).not.toContain("Pick one");

		component.handleInput("pageUp");
		expect((component.render(100) as string[]).join("\n")).toContain("Pick one");
	});

	it("clamps scrolling at the end of the context and shows the last line", async () => {
		const component = await buildAskComponent(
			{ question: "Pick one", context: LONG_CONTEXT, options: ["Alpha", "Beta"] },
			24,
		);
		component.render(100);
		for (let i = 0; i < 50; i++) {
			component.handleInput("pageDown");
		}
		const text = (component.render(100) as string[]).join("\n");

		expect(text).toMatch(/↑ \d+ lines? above/);
		expect(text).not.toMatch(/↓ \d+ lines? below/);
		expect(text).toContain("ctx line 40");
	});

	it("keeps a multi-select list within the height budget", async () => {
		const options = Array.from({ length: 30 }, (_, i) => ({
			title: `Option ${String(i + 1).padStart(2, "0")}`,
			description: `Description for option ${String(i + 1).padStart(2, "0")} with enough words to wrap onto extra lines at moderate widths`,
		}));
		const component = await buildAskComponent(
			{ question: "Pick several", options, allowMultiple: true },
			24,
		);
		const lines = component.render(100) as string[];

		expect(lines.length).toBeLessThanOrEqual(20);
		const text = lines.join("\n");
		expect(text).toContain("Option 01");
		expect(text).toContain("cancel");
	});

	it("clamps the header in freeform editor mode", async () => {
		const component = await buildAskComponent(
			{ question: "Pick one", context: LONG_CONTEXT, options: ["Alpha"], allowComment: false },
			24,
		);
		component.render(100);
		// 1 option + freeform row: down, down lands on the freeform row.
		component.handleInput("down");
		component.handleInput("down");
		component.handleInput("enter");

		const lines = component.render(100) as string[];
		expect(lines.length).toBeLessThanOrEqual(20);
	});

	it("fits a long single-select option list within the budget (regression guard)", async () => {
		const options = Array.from({ length: 30 }, (_, i) => ({
			title: `Option ${String(i + 1).padStart(2, "0")}`,
			description: "d".repeat(90),
		}));
		const component = await buildAskComponent({ question: "Pick one", options }, 24);
		const lines = component.render(100) as string[];

		expect(lines.length).toBeLessThanOrEqual(20);
		const text = lines.join("\n");
		expect(text).toContain("cancel");
	});

	it("renders short prompts fully without scroll indicators", async () => {
		const component = await buildAskComponent(
			{ question: "Pick one", context: "Short context.", options: ["Alpha", "Beta"] },
			24,
		);
		const lines = component.render(100) as string[];
		const text = lines.join("\n");

		expect(text).toContain("Pick one");
		expect(text).toContain("Short context.");
		expect(text).toContain("→ 1. Alpha");
		expect(text).not.toMatch(/lines? below/);
		expect(lines.length).toBeLessThanOrEqual(20);
	});

	it("fits within a 14-row terminal", async () => {
		const component = await buildAskComponent(
			{ question: "Pick one", context: `x`.repeat(400), options: ["Alpha", "Beta"] },
			14,
		);
		const lines = component.render(60) as string[];

		expect(lines.length).toBeLessThanOrEqual(overlayMaxHeight(14));
	});
});
