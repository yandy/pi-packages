import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const RELEASE_SUFFIX = ":release";

// ---------------------------------------------------------------------------
// Module-level state (var for hoisting so mock factories can close over them)
// ---------------------------------------------------------------------------
var editorInputs: string[] = [];
var editorText = "";
var emittedEvents: Array<{ name: string; payload: any }> = [];

// ---------------------------------------------------------------------------
// vi.mock – hoisted, self-contained factories
// ---------------------------------------------------------------------------
vi.mock("@earendil-works/pi-coding-agent", () => {
	const uninitialisedTheme = new Proxy(
		{},
		{
			get(_target, prop) {
				throw new Error(`Theme not initialized. Call initTheme() first. (read ${String(prop)})`);
			},
		},
	);
	const brokenMarkdownTheme = {
		bold: (text: string) => (uninitialisedTheme as any).bold(text),
		italic: (text: string) => (uninitialisedTheme as any).italic(text),
		heading: (text: string) => (uninitialisedTheme as any).fg("mdHeading", text),
	};
	return {
		DynamicBorder: class {},
		getMarkdownTheme: () => brokenMarkdownTheme,
		rawKeyHint: (key: string, description: string) => `${key} ${description}`,
	};
});

vi.mock("@earendil-works/pi-tui", () => {
	class MockText {
		private text: string;
		constructor(text: string) {
			this.text = text;
		}
		render() {
			return [this.text];
		}
		setText(text: string) {
			this.text = text;
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
		clear() {}
		invalidate() {}
		render() {
			return [];
		}
	}

	class MockEditor {
		disableSubmit = false;
		onSubmit?: (text: string) => void;
		constructor(_tui: any, theme: any) {
			if (!theme?.borderColor) {
				throw new TypeError("Cannot read properties of undefined (reading 'borderColor')");
			}
		}
		handleInput(data?: string) {
			if (typeof data === "string") {
				editorInputs.push(data);
			}
			if (data === "enter") {
				this.onSubmit?.(editorText);
			}
		}
		getText() {
			return editorText;
		}
		setText(text = "") {
			editorText = text;
		}
	}

	class Markdown extends MockText {
		private mdTheme: any;
		constructor(text: string, _a: number, _b: number, theme: any) {
			super(text);
			this.mdTheme = theme;
		}
		render() {
			return super.render().map((line) => this.mdTheme.bold(line));
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
			ctrl: (key: string) => `ctrl+${key}`,
			alt: (key: string) => `alt+${key}`,
			shift: (key: string) => `shift+${key}`,
		},
		Markdown,
		matchesKey: (data: string, key: string) =>
			// Simulate real pi-tui: Kitty keyboard protocol release events
			// (e.g. "alt+o" → [111;3:5u) also match the key binding because
			// matchesKittySequence ignores the event type. We use ":release"
			// suffix to distinguish press from release in tests.
			data === key || data === key + RELEASE_SUFFIX,
		isKeyRelease: (data: string) => data.endsWith(RELEASE_SUFFIX),
		Spacer: class {},
		Text: MockText,
		truncateToWidth: (text: string) => text,
		wrapTextWithAnsi: (text: string) => [text],
		decodeKittyPrintable: (data: string) => (data.length === 1 ? data : undefined),
		fuzzyFilter: <T>(items: T[], query: string, getText: (item: T) => string) => {
			const normalized = query.trim().toLowerCase();
			if (!normalized) return items;
			return items.filter((item) => getText(item).toLowerCase().includes(normalized));
		},
	};
});

vi.mock("typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		String: (value?: unknown) => value,
		Optional: (value: unknown) => value,
		Array: (value: unknown) => value,
		Union: (value: unknown) => value,
		Literal: (value: unknown) => value,
		Boolean: (value?: unknown) => value,
		Number: (value?: unknown) => value,
		Unsafe: (value: unknown) => value,
	},
}));

vi.mock("node:os", () => ({
	homedir: () => "/home/testuser",
}));

// In-memory filesystem for config file tests
let fakeFiles: Record<string, string> = {};

vi.mock("node:fs", () => ({
	existsSync: (path: string) => path in fakeFiles,
	readFileSync: (path: string, _encoding: string) => fakeFiles[path] ?? "",
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const envStubs: Array<() => void> = [];
function stubEnv(key: string, value: string): void {
	const original = process.env[key];
	process.env[key] = value;
	envStubs.push(() => {
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	});
}

function setFakeFile(path: string, content: string): void {
	fakeFiles[path] = content;
}

// 与实现同构：实现用 join(homedir(), ".pi", "agent", "ask-user.json") 与 join(cwd, ".pi", "ask-user.json")
// 构造路径（index.ts:341,354），键必须走同一组合，Windows 上才会命中。
const USER_CONFIG_PATH = join("/home/testuser", ".pi", "agent", "ask-user.json");
const PROJECT_CONFIG_PATH = join("/tmp/project", ".pi", "ask-user.json");

function clearFakeFiles(): void {
	fakeFiles = {};
}

afterEach(() => {
	for (const restore of envStubs.splice(0)) restore();
	clearFakeFiles();
});

function createKeybindings(overrides: Partial<Record<string, string[]>> = {}) {
	const bindings: Record<string, string[]> = {
		"tui.input.submit": ["enter"],
		"tui.input.newLine": ["shift+enter"],
		"tui.select.confirm": ["enter"],
		"tui.select.cancel": ["escape", "ctrl+c"],
		"tui.select.up": ["up"],
		"tui.select.down": ["down"],
		"tui.editor.deleteCharBackward": ["backspace"],
		...overrides,
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

type RegisteredTool = {
	execute: (...args: any[]) => Promise<any>;
	renderResult: (result: any, options: any, theme: any) => any;
};

async function setupTool(): Promise<RegisteredTool> {
	const { default: askUserExtension } = await import("../index");
	let registeredTool: RegisteredTool | undefined;
	emittedEvents = [];
	const pi = {
		registerTool(tool: RegisteredTool) {
			registeredTool = tool;
		},
		events: {
			emit(name: string, payload: any) {
				emittedEvents.push({ name, payload });
			},
		},
	} as any;

	askUserExtension(pi);

	if (!registeredTool) {
		throw new Error("Tool was not registered");
	}

	return registeredTool;
}

function createTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

/**
 * `ctx.ui` 的统一桩：宿主 1.5.x 把 `onTerminalInput` 变成必填成员后，每个内联 `ui: { ... }`
 * 都要补一行；收拢到这里后，宿主再增必填成员只改一处。默认桩就是“用户立刻取消”：
 * `custom` 返回 null、`select`/`input` 返回 undefined、`onTerminalInput` 登记即退订、`notify` 静默。
 * 需要观察副作用时逐用例覆盖对应成员（覆盖项整体替换默认项，不做浅合并）。
 */
function makeUI(overrides: Record<string, unknown> = {}) {
	return {
		custom: async () => null,
		select: async () => undefined,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		...overrides,
	};
}

/**
 * 脚本化的 RPC 宿主：按顺序把每一轮 select 的选项里“包含指定片段”的那一项原样返回，
 * 与真实宿主一样只回传列表里出现过的字符串。片段找不到就抛错，避免测试脚本写错时
 * 静默退化成“用户取消”。picks 用完后返回 undefined（= 用户取消）。
 */
function scriptedSelect(picks: string[]) {
	const calls: Array<{ title: string; options: string[]; opts: any }> = [];
	let round = 0;
	return {
		calls,
		select: async (title: string, options: string[], opts?: any) => {
			calls.push({ title, options, opts });
			const pick = picks[round++];
			if (pick === undefined) return undefined;
			const match = options.find((option) => option.includes(pick));
			if (match === undefined) {
				throw new Error(`scripted pick ${JSON.stringify(pick)} not offered: ${JSON.stringify(options)}`);
			}
			return match;
		},
	};
}

function createOverlayHandle() {
	let hidden = false;
	const calls: boolean[] = [];
	return {
		handle: {
			hide() {},
			setHidden(value: boolean) {
				hidden = value;
				calls.push(value);
			},
			isHidden() {
				return hidden;
			},
			focus() {},
			unfocus() {},
			isFocused() {
				return false;
			},
		},
		calls,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ask_user", () => {
	it("registers with executionMode 'sequential' so the agent loop awaits the user's answer before other tool calls run", async () => {
		const tool = await setupTool();
		expect((tool as any).executionMode).toBe("sequential");
	});

	it("uses overlay mode by default", async () => {
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				}),
			},
		);

		expect(capturedOptions.overlay).toBe(true);
		expect(capturedOptions.overlayOptions.visible).toBeUndefined();
	});

	it("uses non-overlay custom UI when displayMode is inline", async () => {
		const tool = await setupTool();
		let capturedOptions: any;

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				displayMode: "inline",
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				}),
			},
		);

		expect(capturedOptions).toBeUndefined();
		expect(result.details.cancelled).toBe(true);
	});

	it("inline mode resolves with the user's selection", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				displayMode: "inline",
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) =>
						await new Promise((resolve) => {
							factory({ requestRender() {}, terminal: { rows: 24 } }, createTheme(), createKeybindings(), resolve);
							resolve({ kind: "selection", selections: ["A"] });
						}),
				}),
			},
		);

		expect(result.details.cancelled).toBe(false);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["A"] });
	});

	it("inline mode still respects timeout cancellation", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				displayMode: "inline",
				timeout: 5,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) =>
						await new Promise((resolve) => {
							factory({ requestRender() {}, terminal: { rows: 24 } }, createTheme(), createKeybindings(), resolve);
						}),
				}),
			},
		);

		expect(result.details.cancelled).toBe(true);
		expect(result.details.cancelReason).toBe("timeout");
		expect(result.details.response).toBeNull();
	});

	it("uses PI_ASK_USER_DISPLAY_MODE env var when call-level displayMode is omitted", async () => {
		stubEnv("PI_ASK_USER_DISPLAY_MODE", "inline");
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				}),
			},
		);

		expect(capturedOptions).toBeUndefined();
	});

	it("call-level displayMode overrides PI_ASK_USER_DISPLAY_MODE env var", async () => {
		stubEnv("PI_ASK_USER_DISPLAY_MODE", "inline");
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				displayMode: "overlay",
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				}),
			},
		);

		expect(capturedOptions.overlay).toBe(true);
	});

	it("ignores unrecognised PI_ASK_USER_DISPLAY_MODE value and falls back to overlay", async () => {
		stubEnv("PI_ASK_USER_DISPLAY_MODE", "fullscreen");
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				}),
			},
		);

		expect(capturedOptions.overlay).toBe(true);
	});

	describe("overlay hide/show toggle (alt+o)", () => {
		it("registers an onTerminalInput listener and passes onHandle in overlay mode", async () => {
			const tool = await setupTool();
			let capturedOptions: any;
			let inputHandler: ((data: string) => any) | undefined;
			let unsubscribed = false;

			await tool.execute("tool-call-id", { question: "Q", options: ["A"] }, undefined, undefined, {
				hasUI: true,
				ui: makeUI({
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
					onTerminalInput: (handler: (data: string) => any) => {
						inputHandler = handler;
						return () => {
							unsubscribed = true;
						};
					},
				}),
			});

			expect(typeof capturedOptions.onHandle).toBe("function");
			expect(typeof inputHandler).toBe("function");
			expect(unsubscribed).toBe(true);
		});

		it("does not register onTerminalInput in inline mode", async () => {
			const tool = await setupTool();
			let registered = false;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"], displayMode: "inline" },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({
						custom: async () => null,
						onTerminalInput: () => {
							registered = true;
							return () => {};
						},
					}),
				},
			);

			expect(registered).toBe(false);
		});

		it("alt+o toggles overlay visibility via OverlayHandle.setHidden", async () => {
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;
			const notifications: Array<{ message: string; type?: string }> = [];

			await tool.execute("tool-call-id", { question: "Q", options: ["A"] }, undefined, undefined, {
				hasUI: true,
				ui: makeUI({
					custom: async (_factory: any, options: any) => {
						options.onHandle?.(handle);
						// Simulate the user pressing alt+o twice while the overlay is shown.
						const firstResult = inputHandler?.("alt+o");
						const secondResult = inputHandler?.("alt+o");
						expect(firstResult).toEqual({ consume: true });
						expect(secondResult).toEqual({ consume: true });
						return null;
					},
					onTerminalInput: (handler: (data: string) => any) => {
						inputHandler = handler;
						return () => {};
					},
					notify: (message: string, type?: string) => {
						notifications.push({ message, type });
					},
				}),
			});

			expect(calls).toEqual([true, false]);
			expect(notifications).toHaveLength(1);
			expect(notifications[0]?.message).toContain("alt+o");
			expect(notifications[0]?.type).toBe("info");
		});

		it("does not consume ctrl+o from the terminal listener", async () => {
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;

			await tool.execute("tool-call-id", { question: "Q", options: ["A"] }, undefined, undefined, {
				hasUI: true,
				ui: makeUI({
					custom: async (_factory: any, options: any) => {
						options.onHandle?.(handle);
						const result = inputHandler?.("ctrl+o");
						expect(result).toBeUndefined();
						return null;
					},
					onTerminalInput: (handler: (data: string) => any) => {
						inputHandler = handler;
						return () => {};
					},
				}),
			});

			expect(calls).toEqual([]);
		});

		it("does not force a hidden overlay visible during cleanup", async () => {
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;

			await tool.execute("tool-call-id", { question: "Q", options: ["A"] }, undefined, undefined, {
				hasUI: true,
				ui: makeUI({
					custom: async (_factory: any, options: any) => {
						options.onHandle?.(handle);
						// Hide and resolve while still hidden.
						inputHandler?.("alt+o");
						return null;
					},
					onTerminalInput: (handler: (data: string) => any) => {
						inputHandler = handler;
						return () => {};
					},
				}),
			});

			expect(calls).toEqual([true]);
		});

		it("ignores Kitty keyboard protocol key release events to prevent overlay flicker", async () => {
			// When Kitty keyboard protocol is active, a single key chord (e.g. alt+o)
			// produces two events: a press event and a release event. Both match the
			// same key binding (matchesKittySequence ignores event type). Without
			// isKeyRelease filtering, the release event would toggle the overlay back
			// to visible immediately after hiding, causing a flicker.
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;
			const notifications: Array<{ message: string; type?: string }> = [];

			await tool.execute("tool-call-id", { question: "Q", options: ["A"] }, undefined, undefined, {
				hasUI: true,
				ui: makeUI({
					custom: async (_factory: any, options: any) => {
						options.onHandle?.(handle);
						// Simulate key-down (press) of alt+o → should hide the overlay.
						const pressResult = inputHandler?.("alt+o");
						// Simulate key-up (release) of alt+o → should be ignored.
						const releaseResult = inputHandler?.("alt+o" + RELEASE_SUFFIX);
						expect(pressResult).toEqual({ consume: true });
						// Release event should NOT be consumed by the toggle handler.
						expect(releaseResult).toBeUndefined();
						return null;
					},
					onTerminalInput: (handler: (data: string) => any) => {
						inputHandler = handler;
						return () => {};
					},
					notify: (message: string, type?: string) => {
						notifications.push({ message, type });
					},
				}),
			});

			// Only one call: setHidden(true) for the press event.
			// The release event must not toggle the overlay back.
			expect(calls).toEqual([true]);
			expect(notifications).toHaveLength(1);
		});

		it("per-call overlayToggleKey replaces the default alt+o binding", async () => {
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;
			const notifications: Array<{ message: string; type?: string }> = [];

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"], overlayToggleKey: "alt+h" },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({
						custom: async (_factory: any, options: any) => {
							options.onHandle?.(handle);
							const ignored = inputHandler?.("alt+o");
							const consumed = inputHandler?.("alt+h");
							expect(ignored).toBeUndefined();
							expect(consumed).toEqual({ consume: true });
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {};
						},
						notify: (message: string, type?: string) => {
							notifications.push({ message, type });
						},
					}),
				},
			);

			expect(calls).toEqual([true]);
			expect(notifications).toHaveLength(1);
			expect(notifications[0]?.message).toContain("alt+h");
		});

		it("PI_ASK_USER_OVERLAY_TOGGLE_KEY env var overrides default", async () => {
			stubEnv("PI_ASK_USER_OVERLAY_TOGGLE_KEY", "alt+h");
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;

			await tool.execute("tool-call-id", { question: "Q", options: ["A"] }, undefined, undefined, {
				hasUI: true,
				ui: makeUI({
					custom: async (_factory: any, options: any) => {
						options.onHandle?.(handle);
						const ignored = inputHandler?.("alt+o");
						const consumed = inputHandler?.("alt+h");
						expect(ignored).toBeUndefined();
						expect(consumed).toEqual({ consume: true });
						return null;
					},
					onTerminalInput: (handler: (data: string) => any) => {
						inputHandler = handler;
						return () => {};
					},
				}),
			});

			expect(calls).toEqual([true]);
		});

		it("per-call overlayToggleKey wins over env var", async () => {
			stubEnv("PI_ASK_USER_OVERLAY_TOGGLE_KEY", "alt+h");
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"], overlayToggleKey: "alt+x" },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({
						custom: async (_factory: any, options: any) => {
							options.onHandle?.(handle);
							const ignoredEnv = inputHandler?.("alt+h");
							const consumed = inputHandler?.("alt+x");
							expect(ignoredEnv).toBeUndefined();
							expect(consumed).toEqual({ consume: true });
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {};
						},
					}),
				},
			);

			expect(calls).toEqual([true]);
		});

		it("overlayToggleKey 'off' disables the listener entirely", async () => {
			const tool = await setupTool();
			let registered = false;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"], overlayToggleKey: "off" },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({
						custom: async () => null,
						onTerminalInput: () => {
							registered = true;
							return () => {};
						},
					}),
				},
			);

			expect(registered).toBe(false);
		});

		it("invalid overlayToggleKey falls through to env var", async () => {
			stubEnv("PI_ASK_USER_OVERLAY_TOGGLE_KEY", "alt+h");
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"], overlayToggleKey: "++bad++" },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({
						custom: async (_factory: any, options: any) => {
							options.onHandle?.(handle);
							const consumed = inputHandler?.("alt+h");
							expect(consumed).toEqual({ consume: true });
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {};
						},
					}),
				},
			);

			expect(calls).toEqual([true]);
		});
	});

	it("renders partial updates as waiting state instead of a successful empty answer", async () => {
		const tool = await setupTool();
		let partialUpdate: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			(update: any) => {
				partialUpdate = update;
			},
			{
				hasUI: true,
				ui: makeUI({
					custom: async () => null,
				}),
			},
		);

		const component = tool.renderResult(partialUpdate, { expanded: false, isPartial: true }, createTheme()) as any;
		const rendered = component.render(120).join("\n");

		expect(rendered).toContain("Waiting for user input...");
		expect(rendered).not.toContain("✓");
	});

	it("marks each selected option in expanded multi-select results", async () => {
		const tool = await setupTool();
		const component = tool.renderResult(
			{
				content: [{ type: "text", text: "User answered: A, B" }],
				details: {
					question: "Choose one or more",
					options: [{ title: "A" }, { title: "B" }, { title: "C" }],
					response: { kind: "selection", selections: ["A", "B"] },
					cancelled: false,
				},
			},
			{ expanded: true, isPartial: false },
			createTheme(),
		) as any;

		const rendered = component.render(120).join("\n");

		expect(rendered).toContain("● A");
		expect(rendered).toContain("● B");
		expect(rendered).toContain("○ C");
	});

	it("renders selection comments separately in expanded results", async () => {
		const tool = await setupTool();
		const component = tool.renderResult(
			{
				content: [{ type: "text", text: "User answered: Blue" }],
				details: {
					question: "Pick a color",
					options: [{ title: "Red" }, { title: "Blue" }, { title: "Green" }],
					response: { kind: "selection", selections: ["Blue"], comment: "Match the current brand palette." },
					cancelled: false,
				},
			},
			{ expanded: true, isPartial: false },
			createTheme(),
		) as any;

		const rendered = component.render(120).join("\n");

		expect(rendered).toContain("● Blue");
		expect(rendered).toContain("Comment:");
		expect(rendered).toContain("Match the current brand palette.");
	});

	it("uses shared confirm keybinding in single-select mode", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings({ "tui.select.confirm": ["x"] }),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("x");
						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["A"] });
		expect(result.details.cancelled).toBe(false);
	});

	it("forwards ctrl+enter to the editor instead of submitting freeform mode", async () => {
		const tool = await setupTool();
		editorInputs = [];
		editorText = "draft answer";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				allowFreeform: true,
				allowComment: false,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("down");
						component.handleInput("down");
						component.handleInput("enter");
						component.handleInput("ctrl+enter");

						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.cancelled).toBe(true);
		expect(editorInputs).toEqual(["ctrl+enter"]);
	});

	it("filters single-select options from typed search before confirming", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta", "Gamma"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("b");
						component.handleInput("enter");
						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta"] });
		expect(result.details.cancelled).toBe(false);
	});

	it("navigates single-select options with ctrl+j (vim down)", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta", "Gamma"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("ctrl+j");
						component.handleInput("enter");
						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta"] });
		expect(result.details.cancelled).toBe(false);
	});

	it("wraps to last option when ctrl+k (vim up) is pressed at the top", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta", "Gamma"],
				allowFreeform: false,
				allowComment: false,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("ctrl+k");
						component.handleInput("enter");
						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["Gamma"] });
		expect(result.details.cancelled).toBe(false);
	});

	it("treats bare j as fuzzy-search input rather than navigation", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "June", "Gamma"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("j");
						component.handleInput("enter");
						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["June"] });
		expect(result.details.cancelled).toBe(false);
	});

	it("navigates multi-select options with ctrl+j before toggling", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which options should we use?",
				options: ["Alpha", "Beta", "Gamma"],
				allowMultiple: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: any;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: any) => {
								resolved = value;
							},
						);

						component.handleInput("ctrl+j");
						component.handleInput("space");
						component.handleInput("enter");
						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta"] });
		expect(result.details.cancelled).toBe(false);
	});

	it("treats out-of-range number keys as search input in single-select mode", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta 7", "Gamma"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("7");
						component.handleInput("enter");
						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta 7"] });
		expect(result.details.cancelled).toBe(false);
	});

	it("keeps freeform available when search filters out every option", async () => {
		const tool = await setupTool();
		editorInputs = [];

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowFreeform: true,
				allowComment: false,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("z");
						component.handleInput("z");
						component.handleInput("z");
						component.handleInput("enter");
						editorText = "custom from editor";
						component.handleInput("enter");
						return resolved ?? null;
					},
				}),
			},
		);

		const answeredEvent = emittedEvents.find((event) => event.name === "ask:answered");

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "freeform", text: "custom from editor" });
		expect(result.details.cancelled).toBe(false);
		expect(answeredEvent?.payload.response).toEqual({ kind: "freeform", text: "custom from editor" });
		expect(editorInputs).toEqual(["enter"]);
	});

	it("shows the remapped cancel key in freeform help text", async () => {
		const tool = await setupTool();
		let helpText = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowFreeform: true,
				allowComment: false,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings({ "tui.select.cancel": ["q"] }),
							() => {},
						);

						component.handleInput("down");
						component.handleInput("down");
						component.handleInput("enter");
						helpText = (component as any).helpText.render().join("\n");
						return null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(helpText).toContain("enter submit");
		expect(helpText).toContain("alt+o hide");
		expect(helpText).toContain("q cancel");
		expect(helpText).not.toContain("ctrl+c cancel");
	});

	it("renders a details pane for wide single-select layouts", async () => {
		const tool = await setupTool();
		let rendered = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: [
					{ title: "Alpha", description: "The alpha option keeps the rollout conservative." },
					{ title: "Beta", description: "The beta option favors faster iteration." },
				],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);
						rendered = ((component as any).singleSelectList as any).render(120).join("\n");
						return null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(rendered).toContain("## Alpha");
		expect(rendered).toContain("The alpha option keeps the rollout conservative.");
	});

	it("shows a custom response preview in the wide details pane", async () => {
		const tool = await setupTool();
		let rendered = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowFreeform: true,
				allowComment: false,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);
						component.handleInput("down");
						component.handleInput("down");
						rendered = ((component as any).singleSelectList as any).render(120).join("\n");
						return null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(rendered).toContain("Custom response");
		expect(rendered).toContain("Open the editor to write **any** answer.");
	});

	it("falls back to the single-column list on narrow widths", async () => {
		const tool = await setupTool();
		let rendered = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: [
					{ title: "Alpha", description: "The alpha option keeps the rollout conservative." },
					{ title: "Beta", description: "The beta option favors faster iteration." },
				],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);
						rendered = ((component as any).singleSelectList as any).render(60).join("\n");
						return null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(rendered).not.toContain("Details");
		expect(rendered).not.toContain(" │ ");
		expect(rendered).toContain("The alpha option keeps the rollout conservative.");
	});

	it("submits immediately when the comment toggle is off", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowComment: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: any;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: any) => {
								resolved = value;
							},
						);

						component.handleInput("enter");
						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["Alpha"] });
		expect(result.details.cancelled).toBe(false);
	});

	it("shows the comment toggle by default when allowComment is omitted", async () => {
		const tool = await setupTool();
		let rendered = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						rendered = ((component as any).singleSelectList as any).render(120).join("\n");
						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(rendered).toContain("[ ] Add extra context after selection");
	});

	it("does not render the comment toggle when allowComment is false", async () => {
		const tool = await setupTool();
		let rendered = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowComment: false,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						rendered = ((component as any).singleSelectList as any).render(120).join("\n");
						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(rendered).not.toContain("Add extra context after selection");
	});

	it("toggles extra context with the ctrl+g key and shows it in help text", async () => {
		const tool = await setupTool();
		let renderedBefore = "";
		let renderedAfter = "";
		let helpText = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowComment: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);

						renderedBefore = ((component as any).singleSelectList as any).render(80).join("\n");
						helpText = (component as any).helpText.render().join("\n");
						component.handleInput("ctrl+g");
						renderedAfter = ((component as any).singleSelectList as any).render(80).join("\n");
						return null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(renderedBefore).toContain("[ ] Add extra context after selection");
		expect(renderedAfter).toContain("[✓] Add extra context after selection");
		expect(helpText).toContain("ctrl+g toggle context");
	});

	it("uses custom commentToggleKey for comment toggling and help text", async () => {
		const tool = await setupTool();
		let renderedBefore = "";
		let renderedAfterIgnored = "";
		let renderedAfterCustom = "";
		let helpText = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowComment: true,
				commentToggleKey: "alt+c",
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);

						renderedBefore = ((component as any).singleSelectList as any).render(80).join("\n");
						helpText = (component as any).helpText.render().join("\n");
						// Default ctrl+g should no longer toggle.
						component.handleInput("ctrl+g");
						renderedAfterIgnored = ((component as any).singleSelectList as any).render(80).join("\n");
						// Configured alt+c should toggle.
						component.handleInput("alt+c");
						renderedAfterCustom = ((component as any).singleSelectList as any).render(80).join("\n");
						return null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(renderedBefore).toContain("[ ] Add extra context after selection");
		expect(renderedAfterIgnored).toContain("[ ] Add extra context after selection");
		expect(renderedAfterCustom).toContain("[✓] Add extra context after selection");
		expect(helpText).toContain("alt+c toggle context");
		expect(helpText).not.toContain("ctrl+g toggle context");
	});

	it("commentToggleKey 'off' hides the toggle hint and ignores ctrl+g", async () => {
		const tool = await setupTool();
		let renderedBefore = "";
		let renderedAfter = "";
		let helpText = "";

		await tool.execute(
			"tool-call-id",
			{
				question: "Q",
				options: ["Alpha", "Beta"],
				allowComment: true,
				commentToggleKey: "off",
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);
						renderedBefore = ((component as any).singleSelectList as any).render(80).join("\n");
						helpText = (component as any).helpText.render().join("\n");
						component.handleInput("ctrl+g");
						renderedAfter = ((component as any).singleSelectList as any).render(80).join("\n");
						return null;
					},
				}),
			},
		);

		expect(renderedBefore).toContain("[ ] Add extra context after selection");
		expect(renderedAfter).toContain("[ ] Add extra context after selection");
		expect(helpText).not.toContain("toggle context");
	});

	it("collects an optional comment after a single selection before resolving", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowComment: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: any;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: any) => {
								resolved = value;
							},
						);

						component.handleInput("ctrl+g");
						component.handleInput("enter");
						expect(resolved).toBeUndefined();
						editorText = "Needs audit logging before rollout.";
						component.handleInput("enter");
						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["Alpha"],
			comment: "Needs audit logging before rollout.",
		});
		expect(result.details.cancelled).toBe(false);
	});

	it("collects an optional comment for multi-select answers", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which options should we use?",
				options: ["Alpha", "Beta", "Gamma"],
				allowMultiple: true,
				allowComment: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let resolved: any;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: any) => {
								resolved = value;
							},
						);

						component.handleInput("space");
						component.handleInput("down");
						component.handleInput("down");
						component.handleInput("space");
						component.handleInput("ctrl+g");
						component.handleInput("enter");
						expect(resolved).toBeUndefined();
						editorText = "Roll out both behind the same flag.";
						component.handleInput("enter");
						return resolved ?? null;
					},
				}),
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["Alpha", "Gamma"],
			comment: "Roll out both behind the same flag.",
		});
		expect(result.details.cancelled).toBe(false);
	});

	it("does not crash when host theme singleton is uninitialised (regression for #17)", async () => {
		const tool = await setupTool();
		let constructionError: unknown;
		let previewError: unknown;
		let preview = "";

		await tool.execute(
			"tool-call-id",
			{
				question: "Pick one",
				context: "Some **markdown** context",
				options: [
					{ title: "Alpha", description: "First **emphasised** option" },
					{ title: "Beta", description: "Second option" },
				],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => {
						let component: any;
						try {
							component = factory(
								{ requestRender() {}, terminal: { rows: 24 } },
								createTheme(),
								createKeybindings(),
								() => {},
							);
						} catch (err) {
							constructionError = err;
							return null;
						}
						try {
							preview = (component.singleSelectList as any).render(120).join("\n");
						} catch (err) {
							previewError = err;
						}
						return null;
					},
				}),
			},
		);

		expect(constructionError).toBeUndefined();
		expect(previewError).toBeUndefined();
		expect(preview).toContain("## Alpha");
		expect(preview).toContain("First **emphasised** option");
	});

	describe("RPC fallback (custom() returns undefined)", () => {
		it("single-select falls back to ctx.ui.select()", async () => {
			const tool = await setupTool();
			let selectTitle = "";
			let selectOptions: string[] = [];

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
					allowFreeform: false,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({
						custom: async () => undefined,
						select: async (title: string, opts: string[]) => {
							selectTitle = title;
							selectOptions = opts;
							return "Blue";
						},
						input: async () => undefined,
					}),
				},
			);

			expect(result.isError).not.toBe(true);
			expect(result.details.response).toEqual({ kind: "selection", selections: ["Blue"] });
			expect(result.details.cancelled).toBe(false);
			expect(selectTitle).toContain("Pick a color");
			expect(selectOptions).toEqual(["Red", "Blue"]);
		});

		it("single-select with freeform appends sentinel option", async () => {
			const tool = await setupTool();
			let selectOptions: string[] = [];

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
					allowFreeform: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({
						custom: async () => undefined,
						select: async (_title: string, opts: string[]) => {
							selectOptions = opts;
							return "Red";
						},
						input: async () => undefined,
					}),
				},
			);

			expect(result.isError).not.toBe(true);
			expect(result.details.response).toEqual({ kind: "selection", selections: ["Red"] });
			// Last option should be the freeform sentinel
			expect(selectOptions).toHaveLength(3);
			expect(selectOptions[2]).toContain("Type custom response");
		});

		it("selecting freeform sentinel follows up with input()", async () => {
			const tool = await setupTool();
			let inputCalled = false;
			const sentinel = "\u270f\ufe0f Type custom response...";

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
					allowFreeform: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({
						custom: async () => undefined,
						select: async () => sentinel,
						input: async () => {
							inputCalled = true;
							return "Purple";
						},
					}),
				},
			);

			expect(result.isError).not.toBe(true);
			expect(inputCalled).toBe(true);
			expect(result.details.response).toEqual({ kind: "freeform", text: "Purple" });
		});

		it("collects an optional comment by default when the custom UI is unavailable", async () => {
			const tool = await setupTool();
			const inputTitles: string[] = [];

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({
						custom: async () => undefined,
						select: async () => "Blue",
						input: async (title: string) => {
							inputTitles.push(title);
							return "Prefer the darker shade.";
						},
					}),
				},
			);

			expect(result.isError).not.toBe(true);
			expect(inputTitles).toHaveLength(1);
			expect(result.details.response).toEqual({
				kind: "selection",
				selections: ["Blue"],
				comment: "Prefer the darker shade.",
			});
			expect(result.details.cancelled).toBe(false);
		});

		it("returns cancelled when select() returns undefined", async () => {
			const tool = await setupTool();

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({
						custom: async () => undefined,
						select: async () => undefined,
						input: async () => undefined,
					}),
				},
			);

			expect(result.details.cancelled).toBe(true);
			expect(result.details.response).toBeNull();
		});

		it("passes context into the dialog prompt", async () => {
			const tool = await setupTool();
			let selectTitle = "";

			await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					context: "The sky is blue today.",
					options: ["Red", "Blue"],
					allowFreeform: false,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({
						custom: async () => undefined,
						select: async (title: string) => {
							selectTitle = title;
							return "Blue";
						},
						input: async () => undefined,
					}),
				},
			);

			expect(selectTitle).toContain("The sky is blue today.");
		});

		it("passes timeout and an abort signal to dialog methods", async () => {
			const tool = await setupTool();
			let capturedOpts: any;

			await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
					allowFreeform: false,
					timeout: 5000,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({
						custom: async () => undefined,
						select: async (_title: string, _opts: string[], opts: any) => {
							capturedOpts = opts;
							return "Red";
						},
						input: async () => undefined,
					}),
				},
			);

			expect(capturedOpts.timeout).toBe(5000);
			expect(capturedOpts.signal).toBeInstanceOf(AbortSignal);
		});
	});

	// issue #246: RPC 宿主漏实现 select/input 时应答永不到达。宿主的 createDialogPromise 只在
	// opts.timeout / opts.signal 存在时才注册结算通道，所以工具必须自带 deadline 与 abort 通路，
	// 否则 executionMode: "sequential" 会把整轮 turn 永久挂死。
	describe("dialog settlement without a responding host (issue #246)", () => {
		const DEFAULT_DEADLINE_MS = 300_000;

		/** 永不 settle 的 dialog：模拟漏实现该方法的 RPC 宿主。 */
		function hangingDialog<T>(): Promise<T> {
			return new Promise<T>(() => {});
		}

		function dialogCtx(ui: Record<string, unknown>, mode = "rpc") {
			return {
				hasUI: true,
				mode,
				cwd: "/tmp/project",
				ui: makeUI({ custom: async () => undefined, ...ui }),
			};
		}

		/** 在假时钟下跑 execute，返回「是否已结算」探针与结果 promise。 */
		function runWithFakeTimers(execute: () => Promise<any>) {
			let settled = false;
			const promise = execute().then((result: any) => {
				settled = true;
				return result;
			});
			return { promise, isSettled: () => settled };
		}

		it("auto-cancels with a timeout reason when the host never answers select()", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const { promise, isSettled } = runWithFakeTimers(() =>
					tool.execute(
						"tool-call-id",
						{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false },
						undefined,
						undefined,
						dialogCtx({ select: () => hangingDialog<string>() }),
					),
				);

				await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);

				expect(isSettled()).toBe(true);
				const result = await promise;
				expect(result.details.cancelled).toBe(true);
				expect(result.details.cancelReason).toBe("timeout");
				expect(result.content[0].text).toContain("Timed out");
				expect(result.content[0].text).toContain(String(DEFAULT_DEADLINE_MS));
			} finally {
				vi.useRealTimers();
			}
		});

		it("keeps waiting until the default deadline elapses", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const { promise, isSettled } = runWithFakeTimers(() =>
					tool.execute(
						"tool-call-id",
						{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false },
						undefined,
						undefined,
						dialogCtx({ select: () => hangingDialog<string>() }),
					),
				);

				await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS - 1);
				expect(isSettled()).toBe(false);

				await vi.advanceTimersByTimeAsync(1);
				expect(isSettled()).toBe(true);
				await promise;
			} finally {
				vi.useRealTimers();
			}
		});

		it("uses an explicit timeout instead of the default deadline", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const { promise, isSettled } = runWithFakeTimers(() =>
					tool.execute(
						"tool-call-id",
						{
							question: "Pick a color",
							options: ["Red", "Blue"],
							allowFreeform: false,
							allowComment: false,
							timeout: 1000,
						},
						undefined,
						undefined,
						dialogCtx({ select: () => hangingDialog<string>() }),
					),
				);

				await vi.advanceTimersByTimeAsync(1000);

				expect(isSettled()).toBe(true);
				const result = await promise;
				expect(result.details.cancelReason).toBe("timeout");
				expect(result.content[0].text).toContain("1000");
			} finally {
				vi.useRealTimers();
			}
		});

		it("falls back to the default deadline when timeout is not a positive number", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const { promise, isSettled } = runWithFakeTimers(() =>
					tool.execute(
						"tool-call-id",
						{
							question: "Pick a color",
							options: ["Red", "Blue"],
							allowFreeform: false,
							allowComment: false,
							timeout: 0,
						},
						undefined,
						undefined,
						dialogCtx({ select: () => hangingDialog<string>() }),
					),
				);

				await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);

				expect(isSettled()).toBe(true);
				const result = await promise;
				expect(result.details.cancelReason).toBe("timeout");
			} finally {
				vi.useRealTimers();
			}
		});

		it("aborts the dialog signal on timeout so a well-behaved host dismisses its prompt", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				let capturedSignal: AbortSignal | undefined;
				const { promise } = runWithFakeTimers(() =>
					tool.execute(
						"tool-call-id",
						{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false },
						undefined,
						undefined,
						dialogCtx({
							select: (_title: string, _options: string[], opts: any) => {
								capturedSignal = opts?.signal;
								return hangingDialog<string>();
							},
						}),
					),
				);

				await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);
				await promise;

				expect(capturedSignal).toBeInstanceOf(AbortSignal);
				expect(capturedSignal?.aborted).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it("settles as cancelled when the tool signal aborts and the host ignores it", async () => {
			const tool = await setupTool();
			const controller = new AbortController();
			let opened: (() => void) | undefined;
			const dialogOpened = new Promise<void>((resolve) => {
				opened = resolve;
			});
			const promise = tool.execute(
				"tool-call-id",
				{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false },
				controller.signal,
				undefined,
				dialogCtx({
					select: () => {
						opened?.();
						return hangingDialog<string>();
					},
				}),
			);

			// 弹窗已打开后才 abort：测的是在飞中断，不是「调用前已中断」。
			await dialogOpened;
			controller.abort();
			const result = await promise;

			expect(result.details.cancelled).toBe(true);
			expect(result.details.cancelReason).toBe("abort");
		});

		it("forwards the tool signal to the host dialog", async () => {
			const tool = await setupTool();
			const controller = new AbortController();
			let capturedSignal: AbortSignal | undefined;
			let opened: (() => void) | undefined;
			const dialogOpened = new Promise<void>((resolve) => {
				opened = resolve;
			});
			const promise = tool.execute(
				"tool-call-id",
				{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false },
				controller.signal,
				undefined,
				dialogCtx({
					select: (_title: string, _options: string[], opts: any) => {
						capturedSignal = opts?.signal;
						opened?.();
						return hangingDialog<string>();
					},
				}),
			);

			await dialogOpened;
			expect(capturedSignal?.aborted).toBe(false);
			controller.abort();
			await promise;

			expect(capturedSignal?.aborted).toBe(true);
		});

		it("does not open a dialog when the signal is already aborted", async () => {
			const tool = await setupTool();
			const controller = new AbortController();
			controller.abort();
			let selectCalls = 0;

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick a color", options: ["Red", "Blue"] },
				controller.signal,
				undefined,
				dialogCtx({
					select: () => {
						selectCalls += 1;
						return hangingDialog<string>();
					},
				}),
			);

			expect(selectCalls).toBe(0);
			expect(result.details.cancelled).toBe(true);
		});

		it("reports a host-side cancel as a plain cancel, not a timeout", async () => {
			const tool = await setupTool();

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false },
				undefined,
				undefined,
				dialogCtx({ select: async () => undefined }),
			);

			expect(result.details.cancelled).toBe(true);
			expect(result.details.cancelReason).toBeUndefined();
			expect(result.content[0].text).toBe("User cancelled the question");
		});

		it("cancels when the comment step times out instead of silently dropping the comment", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const { promise, isSettled } = runWithFakeTimers(() =>
					tool.execute(
						"tool-call-id",
						{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: true },
						undefined,
						undefined,
						dialogCtx({ select: async () => "Red", input: () => hangingDialog<string>() }),
					),
				);

				await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);

				expect(isSettled()).toBe(true);
				const result = await promise;
				expect(result.details.cancelled).toBe(true);
				expect(result.details.cancelReason).toBe("timeout");
			} finally {
				vi.useRealTimers();
			}
		});

		it("auto-cancels the multi-select select rounds when the host never answers", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const { promise, isSettled } = runWithFakeTimers(() =>
					tool.execute(
						"tool-call-id",
						{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true },
						undefined,
						undefined,
						dialogCtx({ select: () => hangingDialog<string>() }),
					),
				);

				await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);

				expect(isSettled()).toBe(true);
				const result = await promise;
				expect(result.details.cancelReason).toBe("timeout");
			} finally {
				vi.useRealTimers();
			}
		});

		it("auto-cancels a later multi-select round when the host stops answering mid-pick", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				let round = 0;
				const { promise, isSettled } = runWithFakeTimers(() =>
					tool.execute(
						"tool-call-id",
						{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true, allowFreeform: false },
						undefined,
						undefined,
						dialogCtx({
							select: (_title: string, options: string[]) => {
								round += 1;
								// 第一轮勾选 Red，第二轮宿主不再应答。
								if (round === 1) return Promise.resolve(options[0]);
								return hangingDialog<string>();
							},
						}),
					),
				);

				await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);

				expect(isSettled()).toBe(true);
				const result = await promise;
				expect(round).toBe(2);
				expect(result.details.cancelled).toBe(true);
				expect(result.details.cancelReason).toBe("timeout");
			} finally {
				vi.useRealTimers();
			}
		});

		it("auto-cancels the option-less freeform input in non-TUI modes", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const { promise, isSettled } = runWithFakeTimers(() =>
					tool.execute(
						"tool-call-id",
						{ question: "What is your name?" },
						undefined,
						undefined,
						dialogCtx({ input: () => hangingDialog<string>() }),
					),
				);

				await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);

				expect(isSettled()).toBe(true);
				const result = await promise;
				expect(result.details.cancelled).toBe(true);
				expect(result.details.cancelReason).toBe("timeout");
			} finally {
				vi.useRealTimers();
			}
		});

		it("imposes no default deadline on the option-less input in TUI mode", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				let answer: ((value: string) => void) | undefined;
				const { promise, isSettled } = runWithFakeTimers(() =>
					tool.execute(
						"tool-call-id",
						{ question: "What is your name?" },
						undefined,
						undefined,
						dialogCtx(
							{
								input: () =>
									new Promise<string>((resolve) => {
										answer = resolve;
									}),
							},
							"tui",
						),
					),
				);

				await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS * 2);
				expect(isSettled()).toBe(false);

				answer?.("Ada");
				const result = await promise;
				expect(result.details.response).toEqual({ kind: "freeform", text: "Ada" });
			} finally {
				vi.useRealTimers();
			}
		});

		it("clears the deadline timer once the host answers", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const result = await tool.execute(
					"tool-call-id",
					{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false },
					undefined,
					undefined,
					dialogCtx({ select: async () => "Red" }),
				);

				expect(result.details.cancelled).toBe(false);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("dialog settlement contract (issue #255)", () => {
		const DEFAULT_DEADLINE_MS = 300_000;

		function dialogCtx(ui: Record<string, unknown>, mode = "rpc") {
			return {
				hasUI: true,
				mode,
				cwd: "/tmp/project",
				ui: makeUI({ custom: async () => undefined, ...ui }),
			};
		}

		/**
		 * 宿主在 opts.signal abort 时同步 reject。标准 Pi 宿主在 abort 时 resolve(undefined)，
		 * 但扩展 UI 接口并未禁止别的宿主用 rejection 收尾。
		 */
		function rejectOnAbort<T>(onOpen?: () => void) {
			return (...args: unknown[]) => {
				const opts = args.at(-1) as { signal: AbortSignal };
				const promise = new Promise<T>((_resolve, reject) => {
					opts.signal.addEventListener("abort", () => reject(new Error("host rejected abort")));
				});
				onOpen?.();
				return promise;
			};
		}

		it("keeps a local timeout when select rejects from inside the abort listener", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const promise = tool.execute(
					"tool-call-id",
					{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false },
					undefined,
					undefined,
					dialogCtx({ select: rejectOnAbort<string>() }),
				);

				await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);
				const result = await promise;

				expect(result.isError).not.toBe(true);
				expect(result.details.cancelled).toBe(true);
				expect(result.details.cancelReason).toBe("timeout");
				expect(result.content[0].text).toContain("Timed out");
			} finally {
				vi.useRealTimers();
			}
		});

		it("keeps a local abort when input rejects from inside the abort listener", async () => {
			const tool = await setupTool();
			const controller = new AbortController();
			let opened: (() => void) | undefined;
			const dialogOpened = new Promise<void>((resolve) => {
				opened = resolve;
			});

			const promise = tool.execute(
				"tool-call-id",
				{ question: "What is your name?" },
				controller.signal,
				undefined,
				dialogCtx({ input: rejectOnAbort<string>(() => opened?.()) }),
			);

			await dialogOpened;
			controller.abort();
			const result = await promise;

			expect(result.isError).not.toBe(true);
			expect(result.details.cancelled).toBe(true);
			expect(result.details.cancelReason).toBe("abort");
		});

		it("keeps a local timeout when the comment follow-up input rejects on abort", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const promise = tool.execute(
					"tool-call-id",
					{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: true, timeout: 1000 },
					undefined,
					undefined,
					dialogCtx({ select: async () => "Red", input: rejectOnAbort<string>() }),
				);

				await vi.advanceTimersByTimeAsync(1000);
				const result = await promise;

				expect(result.isError).not.toBe(true);
				expect(result.details.cancelled).toBe(true);
				expect(result.details.cancelReason).toBe("timeout");
			} finally {
				vi.useRealTimers();
			}
		});

		it("keeps a local timeout when a later multi-select round rejects on abort", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				let round = 0;
				const promise = tool.execute(
					"tool-call-id",
					{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true, allowFreeform: false, allowComment: false },
					undefined,
					undefined,
					dialogCtx({
						select: (...args: unknown[]) => {
							round += 1;
							if (round === 1) return Promise.resolve((args[1] as string[])[0]);
							return rejectOnAbort<string>()(...args);
						},
					}),
				);

				await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);
				const result = await promise;

				expect(round).toBe(2);
				expect(result.isError).not.toBe(true);
				expect(result.details.cancelled).toBe(true);
				expect(result.details.cancelReason).toBe("timeout");
			} finally {
				vi.useRealTimers();
			}
		});

		it("keeps a local timeout when the option-less input rejects on abort", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const promise = tool.execute(
					"tool-call-id",
					{ question: "What is your name?" },
					undefined,
					undefined,
					dialogCtx({ input: rejectOnAbort<string>() }),
				);

				await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);
				const result = await promise;

				expect(result.isError).not.toBe(true);
				expect(result.details.cancelled).toBe(true);
				expect(result.details.cancelReason).toBe("timeout");
			} finally {
				vi.useRealTimers();
			}
		});

		it("ignores a host answer that arrives after a local timeout", async () => {
			const tool = await setupTool();
			let resolveHost: ((value: string) => void) | undefined;

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false, timeout: 10 },
				undefined,
				undefined,
				dialogCtx({
					select: () =>
						new Promise<string>((resolve) => {
							resolveHost = resolve;
						}),
				}),
			);

			expect(result.details.cancelReason).toBe("timeout");
			resolveHost?.("Red");
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(result.details.cancelled).toBe(true);
			expect(result.details.response).toBeNull();
		});

		it("absorbs a host rejection that arrives after a local timeout", async () => {
			const tool = await setupTool();
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", onUnhandled);
			try {
				const result = await tool.execute(
					"tool-call-id",
					{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false, timeout: 10 },
					undefined,
					undefined,
					dialogCtx({
						select: () =>
							new Promise<string>((_resolve, reject) => {
								setTimeout(() => reject(new Error("late host rejection")), 40);
							}),
					}),
				);

				expect(result.details.cancelReason).toBe("timeout");
				await new Promise((resolve) => setTimeout(resolve, 80));
				expect(unhandled).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});

		it("keeps a local abort when the host throws synchronously after the abort", async () => {
			const tool = await setupTool();
			const controller = new AbortController();

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false },
				controller.signal,
				undefined,
				dialogCtx({
					select: () => {
						controller.abort();
						throw new Error("host failed after abort");
					},
				}),
			);

			expect(result.isError).not.toBe(true);
			expect(result.details.cancelled).toBe(true);
			expect(result.details.cancelReason).toBe("abort");
		});

		it("reports an ordinary host failure as a real error, not a timeout", async () => {
			const tool = await setupTool();

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false },
				undefined,
				undefined,
				dialogCtx({
					select: async () => {
						throw new Error("socket closed");
					},
				}),
			);

			expect(result.isError).toBe(true);
			expect(result.details.cancelled).not.toBe(true);
			expect(result.details.cancelReason).toBeUndefined();
			expect(result.content[0].text).toContain("socket closed");
		});

		it("reports an ordinary host failure on the option-less input as a structured error", async () => {
			const tool = await setupTool();

			const result = await tool.execute(
				"tool-call-id",
				{ question: "What is your name?" },
				undefined,
				undefined,
				dialogCtx({
					input: async () => {
						throw new Error("socket closed");
					},
				}),
			);

			expect(result.isError).toBe(true);
			expect(result.details.cancelled).not.toBe(true);
			expect(result.details.cancelReason).toBeUndefined();
			expect(result.content[0].text).toContain("socket closed");
		});
	});

	describe("rich TUI cancellation contract (issue #255)", () => {
		function customCtx(
			run: (factory: any, done: (value: unknown) => void) => void,
			overrides: Record<string, unknown> = {},
		) {
			return {
				hasUI: true,
				ui: makeUI({
					custom: async (factory: any) => new Promise((resolve) => run(factory, resolve)),
					...overrides,
				}),
			};
		}

		const TUI = { requestRender() {}, terminal: { rows: 24 } };

		it("records a timeout for the rich TUI and renders it as Timed out", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();

				const result = await tool.execute(
					"tool-call-id",
					{ question: "Which option?", options: ["A", "B"], timeout: 1000 },
					undefined,
					undefined,
					customCtx((factory, done) => {
						factory(TUI, createTheme(), createKeybindings(), done);
						vi.advanceTimersByTime(2000);
					}),
				);

				expect(result.details.cancelled).toBe(true);
				expect(result.details.cancelReason).toBe("timeout");
				expect(result.content[0].text).toContain("Timed out");
				const rendered = tool.renderResult(result, { expanded: false }, createTheme());
				expect(rendered.render().join("\n")).toContain("Timed out");
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it("records an abort for the rich TUI when the tool signal aborts in flight", async () => {
			const tool = await setupTool();
			const controller = new AbortController();
			const doneCalls: unknown[] = [];

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Which option?", options: ["A", "B"] },
				controller.signal,
				undefined,
				customCtx((factory, done) => {
					factory(TUI, createTheme(), createKeybindings(), (value: unknown) => {
						doneCalls.push(value);
						done(value);
					});
					controller.abort();
				}),
			);

			expect(result.details.cancelled).toBe(true);
			expect(result.details.cancelReason).toBe("abort");
			expect(result.content[0].text).toBe("User cancelled the question");
			expect(doneCalls).toEqual([null]);
		});

		it("clears its timer and abort listener after a normal answer", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const controller = new AbortController();
				const removeListener = vi.spyOn(controller.signal, "removeEventListener");
				const doneCalls: unknown[] = [];

				const result = await tool.execute(
					"tool-call-id",
					{ question: "Which option?", options: ["A", "B"], timeout: 1000 },
					controller.signal,
					undefined,
					customCtx((factory, done) => {
						const component = factory(TUI, createTheme(), createKeybindings(), (value: unknown) => {
							doneCalls.push(value);
							done(value);
						});
						component.handleInput("enter");
						vi.advanceTimersByTime(5000);
						controller.abort();
						vi.advanceTimersByTime(5000);
					}),
				);

				expect(result.details.response).toEqual({ kind: "selection", selections: ["A"] });
				expect(result.details.cancelReason).toBeUndefined();
				expect(doneCalls).toEqual([{ kind: "selection", selections: ["A"] }]);
				expect(vi.getTimerCount()).toBe(0);
				expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
			} finally {
				vi.useRealTimers();
			}
		});

		it("clears its timer and abort listener when the rich UI fails after arming them", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const controller = new AbortController();
				const removeListener = vi.spyOn(controller.signal, "removeEventListener");

				const result = await tool.execute(
					"tool-call-id",
					{ question: "Which option?", options: ["A", "B"], timeout: 1000 },
					controller.signal,
					undefined,
					customCtx((factory, done) => {
						factory(TUI, createTheme(), createKeybindings(), done);
						throw new Error("component blew up");
					}),
				);

				expect(result.isError).toBe(true);
				expect(result.content[0].text).toContain("component blew up");
				expect(vi.getTimerCount()).toBe(0);
				expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
			} finally {
				vi.useRealTimers();
			}
		});

		it("leaves cancelReason absent when the user cancels the rich TUI, and cleans up too", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const controller = new AbortController();
				const removeListener = vi.spyOn(controller.signal, "removeEventListener");
				const doneCalls: unknown[] = [];

				const result = await tool.execute(
					"tool-call-id",
					{ question: "Which option?", options: ["A", "B"], timeout: 1000 },
					controller.signal,
					undefined,
					customCtx((factory, done) => {
						const component = factory(TUI, createTheme(), createKeybindings(), (value: unknown) => {
							doneCalls.push(value);
							done(value);
						});
						component.handleInput("escape");
						vi.advanceTimersByTime(5000);
						controller.abort();
					}),
				);

				expect(result.details.cancelled).toBe(true);
				expect(result.details.cancelReason).toBeUndefined();
				expect(result.content[0].text).toBe("User cancelled the question");
				expect(doneCalls).toEqual([null]);
				expect(vi.getTimerCount()).toBe(0);
				expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
			} finally {
				vi.useRealTimers();
			}
		});

		it("ignores a component answer that arrives after the timeout settled it", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const doneCalls: unknown[] = [];
				let component: any;

				const result = await tool.execute(
					"tool-call-id",
					{ question: "Which option?", options: ["A", "B"], timeout: 1000 },
					undefined,
					undefined,
					customCtx((factory, done) => {
						component = factory(TUI, createTheme(), createKeybindings(), (value: unknown) => {
							doneCalls.push(value);
							done(value);
						});
						vi.advanceTimersByTime(2000);
					}),
				);

				expect(result.details.cancelReason).toBe("timeout");
				component.handleInput("enter");
				await Promise.resolve();
				expect(doneCalls).toEqual([null]);
			} finally {
				vi.useRealTimers();
			}
		});

		it("clears its resources when the component constructor throws", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const controller = new AbortController();
				const removeListener = vi.spyOn(controller.signal, "removeEventListener");

				const result = await tool.execute(
					"tool-call-id",
					{ question: "Which option?", options: ["A", "B"], timeout: 1000 },
					controller.signal,
					undefined,
					customCtx((factory, done) => {
						// 组件构造抛错：取消、timeout 都不会发生，只能靠 finally 收尾。
						factory(TUI, undefined, createKeybindings(), done);
					}),
				);

				expect(result.isError).toBe(true);
				expect(vi.getTimerCount()).toBe(0);
				expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
			} finally {
				vi.useRealTimers();
			}
		});

		it("does not open the rich UI when the signal is already aborted", async () => {
			const tool = await setupTool();
			const controller = new AbortController();
			controller.abort();
			let customCalls = 0;

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Which option?", options: ["A", "B"] },
				controller.signal,
				undefined,
				customCtx(() => {
					customCalls += 1;
				}),
			);

			expect(customCalls).toBe(0);
			expect(result.details.cancelled).toBe(true);
			expect(result.details.cancelReason).toBe("abort");
		});
	});

	describe("RPC fallback multi-select", () => {
		it("collects several options through repeated select() rounds", async () => {
			const tool = await setupTool();
			const host = scriptedSelect(["Red", "Green", "Done"]);

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick colors",
					options: [
						{ title: "Red", description: "warm shade" },
						{ title: "Blue", description: "cool shade" },
						{ title: "Green", description: "grass shade" },
					],
					allowMultiple: true,
					allowFreeform: false,
					allowComment: false,
				},
				undefined,
				undefined,
				{ hasUI: true, ui: makeUI({ custom: async () => undefined, select: host.select }) },
			);

			expect(result.isError).not.toBe(true);
			expect(result.details.cancelled).toBe(false);
			expect(result.details.response).toEqual({ kind: "selection", selections: ["Red", "Green"] });
			expect(host.calls).toHaveLength(3);
			// Descriptions stay visible: the dialog prompt carries the full option list.
			expect(host.calls[0]?.title).toContain("warm shade");
			expect(host.calls[0]?.title).toContain("grass shade");
		});

		it("shows the checked state on the option rows of the next round", async () => {
			const tool = await setupTool();
			const host = scriptedSelect(["Red", "Done"]);

			await tool.execute(
				"tool-call-id",
				{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true, allowFreeform: false, allowComment: false },
				undefined,
				undefined,
				{ hasUI: true, ui: makeUI({ custom: async () => undefined, select: host.select }) },
			);

			const firstRound = host.calls[0]?.options ?? [];
			const secondRound = host.calls[1]?.options ?? [];
			expect(secondRound[0]).not.toBe(firstRound[0]);
			expect(secondRound[0]).toContain("Red");
			expect(secondRound[1]).toBe(firstRound[1]);
		});

		it("picking a checked option again unchecks it", async () => {
			const tool = await setupTool();
			const host = scriptedSelect(["Red", "Red", "Blue", "Done"]);

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true, allowFreeform: false, allowComment: false },
				undefined,
				undefined,
				{ hasUI: true, ui: makeUI({ custom: async () => undefined, select: host.select }) },
			);

			expect(result.details.response).toEqual({ kind: "selection", selections: ["Blue"] });
		});

		it("offers a finish row only once at least one option is checked", async () => {
			const tool = await setupTool();
			const host = scriptedSelect(["Red", "Done"]);

			await tool.execute(
				"tool-call-id",
				{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true, allowFreeform: false, allowComment: false },
				undefined,
				undefined,
				{ hasUI: true, ui: makeUI({ custom: async () => undefined, select: host.select }) },
			);

			expect(host.calls[0]?.options).toHaveLength(2);
			expect(host.calls[1]?.options).toHaveLength(3);
		});

		it("offers a freeform row and follows up with input()", async () => {
			const tool = await setupTool();
			const host = scriptedSelect(["Type custom response"]);

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true, allowComment: false },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({ custom: async () => undefined, select: host.select, input: async () => "Purple" }),
				},
			);

			expect(result.isError).not.toBe(true);
			expect(result.details.response).toEqual({ kind: "freeform", text: "Purple" });
		});

		it("collects an optional comment after finishing", async () => {
			const tool = await setupTool();
			const host = scriptedSelect(["Red", "Done"]);

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true, allowFreeform: false },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({ custom: async () => undefined, select: host.select, input: async () => "Both are fine." }),
				},
			);

			expect(result.details.response).toEqual({
				kind: "selection",
				selections: ["Red"],
				comment: "Both are fine.",
			});
		});

		it("treats a cancelled select round as a user cancellation", async () => {
			const tool = await setupTool();
			const host = scriptedSelect(["Red"]);

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true, allowFreeform: false, allowComment: false },
				undefined,
				undefined,
				{ hasUI: true, ui: makeUI({ custom: async () => undefined, select: host.select }) },
			);

			expect(result.isError).not.toBe(true);
			expect(result.details.cancelled).toBe(true);
			expect(result.details.response).toBeNull();
		});

		it("passes the timeout and an abort signal to every select round", async () => {
			const tool = await setupTool();
			const host = scriptedSelect(["Red", "Done"]);

			await tool.execute(
				"tool-call-id",
				{
					question: "Pick colors",
					options: ["Red", "Blue"],
					allowMultiple: true,
					allowFreeform: false,
					allowComment: false,
					timeout: 5000,
				},
				undefined,
				undefined,
				{ hasUI: true, ui: makeUI({ custom: async () => undefined, select: host.select }) },
			);

			expect(host.calls.map((call) => call.opts.timeout)).toEqual([5000, 5000]);
			for (const call of host.calls) {
				expect(call.opts.signal).toBeInstanceOf(AbortSignal);
			}
		});
	});

	describe("RPC fallback answer validation (issue #247)", () => {
		it("multi-select: an answer matching no offered row is a diagnosable error, not a cancellation", async () => {
			const tool = await setupTool();

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick targets", options: ["E2E tests", "Docker build"], allowMultiple: true, allowComment: false },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({ custom: async () => undefined, select: async () => "E2E, 无 docker" }),
				},
			);

			expect(result.isError).toBe(true);
			expect(result.details.cancelled).toBe(false);
			expect(result.details.response).toBeNull();
			expect(result.details.rawInput).toBe("E2E, 无 docker");
			const text = result.content.map((part: any) => part.text).join("\n");
			expect(text).toContain("E2E, 无 docker");
			expect(text).toContain("E2E tests");
			expect(text).toContain("Docker build");
		});

		it("single-select: an answer matching no offered option is a diagnosable error, not a cancellation", async () => {
			const tool = await setupTool();

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({ custom: async () => undefined, select: async () => "Purple" }),
				},
			);

			expect(result.isError).toBe(true);
			expect(result.details.cancelled).toBe(false);
			expect(result.details.rawInput).toBe("Purple");
		});

		it("marks answered dialog-fallback results with fallback: 'dialogs'", async () => {
			const tool = await setupTool();

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({ custom: async () => undefined, select: async () => "Blue", input: async () => undefined }),
				},
			);

			expect(result.details.fallback).toBe("dialogs");
		});

		it("marks cancelled dialog-fallback results with fallback: 'dialogs'", async () => {
			const tool = await setupTool();

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false },
				undefined,
				undefined,
				{ hasUI: true, ui: makeUI({ custom: async () => undefined }) },
			);

			expect(result.details.cancelled).toBe(true);
			expect(result.details.fallback).toBe("dialogs");
		});

		it("does not mark results answered by the custom TUI", async () => {
			const tool = await setupTool();

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick a color", options: ["Red", "Blue"] },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: makeUI({ custom: async () => ({ kind: "selection", selections: ["Red"] }) }),
				},
			);

			expect(result.details.cancelled).toBe(false);
			expect(result.details.fallback).toBeUndefined();
		});
	});

	describe("RPC fallback offered validation (issue #255)", () => {
		const DONE = "\u2713 Done selecting";
		const FREEFORM = "\u270f\ufe0f Type custom response...";

		function dialogCtx(ui: Record<string, unknown>) {
			return {
				hasUI: true,
				cwd: "/tmp/project",
				ui: makeUI({ custom: async () => undefined, ...ui }),
			};
		}

		function errorText(result: any): string {
			return result.content.map((part: any) => part.text).join("\n");
		}

		it("multi-select: an unoffered Done row with allowComment is an answer error, not a cancellation", async () => {
			const tool = await setupTool();
			let inputCalls = 0;

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true, allowComment: true },
				undefined,
				undefined,
				dialogCtx({
					select: async () => DONE,
					input: async () => {
						inputCalls += 1;
						return "should not be reached";
					},
				}),
			);

			expect(result.isError).toBe(true);
			expect(result.details.cancelled).toBe(false);
			expect(result.details.response).toBeNull();
			expect(result.details.rawInput).toBe(DONE);
			expect(result.details.fallback).toBe("dialogs");
			expect(inputCalls).toBe(0);
			expect(errorText(result)).toContain("Red");
			expect(errorText(result)).toContain("Blue");
		});

		it("multi-select: an unoffered Done row without allowComment is an answer error", async () => {
			const tool = await setupTool();

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true, allowComment: false },
				undefined,
				undefined,
				dialogCtx({ select: async () => DONE }),
			);

			expect(result.isError).toBe(true);
			expect(result.details.cancelled).toBe(false);
			expect(result.details.rawInput).toBe(DONE);
		});

		it("multi-select: an unoffered Freeform row does not bypass allowFreeform: false", async () => {
			const tool = await setupTool();
			let inputCalls = 0;

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true, allowFreeform: false, allowComment: false },
				undefined,
				undefined,
				dialogCtx({
					select: async () => FREEFORM,
					input: async () => {
						inputCalls += 1;
						return "free text";
					},
				}),
			);

			expect(result.isError).toBe(true);
			expect(result.details.cancelled).toBe(false);
			expect(result.details.rawInput).toBe(FREEFORM);
			expect(inputCalls).toBe(0);
		});

		it("single-select: an unoffered Freeform row does not bypass allowFreeform: false", async () => {
			const tool = await setupTool();
			let inputCalls = 0;

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick a color", options: ["Red", "Blue"], allowFreeform: false, allowComment: false },
				undefined,
				undefined,
				dialogCtx({
					select: async () => FREEFORM,
					input: async () => {
						inputCalls += 1;
						return "free text";
					},
				}),
			);

			expect(result.isError).toBe(true);
			expect(result.details.cancelled).toBe(false);
			expect(result.details.rawInput).toBe(FREEFORM);
			expect(inputCalls).toBe(0);
		});

		it("multi-select: a row from an earlier round is stale and becomes an answer error", async () => {
			const tool = await setupTool();
			let round = 0;
			let staleRow = "";
			let currentRow = "";

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick colors", options: ["Red", "Blue"], allowMultiple: true, allowFreeform: false, allowComment: false },
				undefined,
				undefined,
				dialogCtx({
					select: async (_title: string, options: string[]) => {
						round += 1;
						if (round === 1) {
							staleRow = options[0] ?? "";
							return staleRow;
						}
						currentRow = options[0] ?? "";
						return staleRow;
					},
				}),
			);

			expect(result.isError).toBe(true);
			expect(result.details.cancelled).toBe(false);
			expect(result.details.rawInput).toBe(staleRow);
			expect(errorText(result)).toContain(staleRow);
			// 错误文本要列出本轮实际 offered 的行（Red 已勾选），而不是上一轮的旧行。
			expect(currentRow).not.toBe(staleRow);
			expect(errorText(result)).toContain(currentRow);
		});

		it("single-select: duplicate option titles still return a valid selection", async () => {
			const tool = await setupTool();

			const result = await tool.execute(
				"tool-call-id",
				{ question: "Pick a shade", options: ["Red", "Red"], allowFreeform: false },
				undefined,
				undefined,
				dialogCtx({ select: async () => "Red" }),
			);

			expect(result.isError).not.toBe(true);
			expect(result.details.response).toEqual({ kind: "selection", selections: ["Red"] });
		});

		it("freeform: an abort-listener rejection on the follow-up input still settles as a local timeout", async () => {
			vi.useFakeTimers();
			try {
				const tool = await setupTool();
				const freeform = "\u270f\ufe0f Type custom response...";
				const promise = tool.execute(
					"tool-call-id",
					{ question: "Pick a color", options: ["Red", "Blue"], allowComment: false, timeout: 1000 },
					undefined,
					undefined,
					dialogCtx({
						select: async () => freeform,
						input: (_title: string, _placeholder: string, opts: any) =>
							new Promise<string>((_resolve, reject) => {
								opts.signal.addEventListener("abort", () => reject(new Error("host rejected abort")));
							}),
					}),
				);

				await vi.advanceTimersByTimeAsync(1000);
				const result = await promise;

				expect(result.isError).not.toBe(true);
				expect(result.details.cancelled).toBe(true);
				expect(result.details.cancelReason).toBe("timeout");
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("config file", () => {
		it("reads displayMode from user config file", async () => {
			setFakeFile(USER_CONFIG_PATH, JSON.stringify({ displayMode: "inline" }));
			const tool = await setupTool();
			let capturedOptions: any;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"] },
				undefined,
				undefined,
				{
					hasUI: true,
					cwd: "/tmp/project",
					ui: makeUI({
						custom: async (_factory: any, options: any) => {
							capturedOptions = options;
							return null;
						},
					}),
				},
			);

			// Inline mode produces undefined custom options (non-overlay)
			expect(capturedOptions).toBeUndefined();
		});

		it("project config overrides user config for displayMode", async () => {
			setFakeFile(USER_CONFIG_PATH, JSON.stringify({ displayMode: "inline" }));
			setFakeFile(PROJECT_CONFIG_PATH, JSON.stringify({ displayMode: "overlay" }));
			const tool = await setupTool();
			let capturedOptions: any;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"] },
				undefined,
				undefined,
				{
					hasUI: true,
					cwd: "/tmp/project",
					ui: makeUI({
						custom: async (_factory: any, options: any) => {
							capturedOptions = options;
							return null;
						},
					}),
				},
			);

			// Project says overlay → overlay mode
			expect(capturedOptions.overlay).toBe(true);
		});

		it("env var overrides config file for displayMode", async () => {
			stubEnv("PI_ASK_USER_DISPLAY_MODE", "inline");
			setFakeFile(USER_CONFIG_PATH, JSON.stringify({ displayMode: "overlay" }));
			const tool = await setupTool();
			let capturedOptions: any;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"] },
				undefined,
				undefined,
				{
					hasUI: true,
					cwd: "/tmp/project",
					ui: makeUI({
						custom: async (_factory: any, options: any) => {
							capturedOptions = options;
							return null;
						},
					}),
				},
			);

			// Env says inline → inline mode, ignoring config
			expect(capturedOptions).toBeUndefined();
		});

		it("reads shortcut keys from config file", async () => {
			setFakeFile(USER_CONFIG_PATH, JSON.stringify({
				overlayToggleKey: "alt+h",
				commentToggleKey: "alt+c",
			}));
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"] },
				undefined,
				undefined,
				{
					hasUI: true,
					cwd: "/tmp/project",
					ui: makeUI({
						custom: async (_factory: any, options: any) => {
							options.onHandle?.(handle);
							const consumed = inputHandler?.("alt+h");
							const ignored = inputHandler?.("alt+o");
							expect(consumed).toEqual({ consume: true });
							expect(ignored).toBeUndefined();
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {};
						},
					}),
				},
			);

			// Config alt+h should work; alt+o should not
			expect(calls).toEqual([true]);
		});

		it("silently ignores malformed config JSON", async () => {
			setFakeFile(USER_CONFIG_PATH, "not-json{{{");
			const tool = await setupTool();
			let capturedOptions: any;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"] },
				undefined,
				undefined,
				{
					hasUI: true,
					cwd: "/tmp/project",
					ui: makeUI({
						custom: async (_factory: any, options: any) => {
							capturedOptions = options;
							return null;
						},
					}),
				},
			);

			// Falls back to default overlay mode
			expect(capturedOptions.overlay).toBe(true);
		});

		it("silently ignores non-string shortcut values in config (spec: type mismatch fallback)", async () => {
			setFakeFile(USER_CONFIG_PATH, JSON.stringify({ overlayToggleKey: 123, commentToggleKey: true }));
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"] },
				undefined,
				undefined,
				{
					hasUI: true,
					cwd: "/tmp/project",
					ui: makeUI({
						custom: async (_factory: any, options: any) => {
							options.onHandle?.(handle);
							const result = inputHandler?.("alt+o");
							// Type mismatch is silently ignored → falls back to default alt+o
							expect(result).toEqual({ consume: true });
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {};
						},
					}),
				},
			);

			// Default alt+o should still work
			expect(calls).toEqual([true]);
		});
	});
});

describe("desktop notification requests", () => {
	const requests = () => emittedEvents.filter((event) => event.name === "notify:request");

	it("emits one critical request before TUI custom UI completes", async () => {
		const tool = await setupTool();
		await tool.execute(
			"tool-call-id",
			{ question: "Which option?", options: ["A"], allowComment: false },
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "tui",
				cwd: "/tmp/project",
				ui: makeUI({
					custom: async () => {
						expect(requests()).toEqual([
							{
								name: "notify:request",
								payload: { title: "Waiting for input", body: "Which option?", urgency: "critical" },
							},
						]);
						return null;
					},
				}),
			},
		);
		expect(requests()).toHaveLength(1);
	});

	it("emits once across custom-to-dialog fallback", async () => {
		const tool = await setupTool();
		let selectCalls = 0;
		await tool.execute(
			"tool-call-id",
			{ question: "Pick one", options: ["A", "B"], allowFreeform: false, allowComment: false },
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "rpc",
				cwd: "/tmp/project",
				ui: makeUI({
					custom: async () => undefined,
					select: async (_title: string, options: string[]) => {
						selectCalls += 1;
						expect(requests()).toHaveLength(1);
						return options[0];
					},
				}),
			},
		);
		expect(selectCalls).toBe(1);
		expect(requests()).toHaveLength(1);
	});

	it("emits once before a freeform-only input", async () => {
		const tool = await setupTool();
		await tool.execute("tool-call-id", { question: "Why?", options: [] }, undefined, undefined, {
			hasUI: true,
			mode: "tui",
			cwd: "/tmp/project",
			ui: makeUI({
				input: async () => {
					expect(requests()).toEqual([
						{ name: "notify:request", payload: { title: "Waiting for input", body: "Why?", urgency: "critical" } },
					]);
					return "because";
				},
			}),
		});
		expect(requests()).toHaveLength(1);
	});

	it("does not repeat requests for multi-select rounds or comments", async () => {
		const tool = await setupTool();
		const scripted = scriptedSelect(["Red", "Done selecting"]);
		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Pick colors",
				options: ["Red", "Blue"],
				allowMultiple: true,
				allowFreeform: false,
				allowComment: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "rpc",
				cwd: "/tmp/project",
				ui: makeUI({ custom: async () => undefined, select: scripted.select, input: async () => "a comment" }),
			},
		);
		expect(result.details.cancelled).toBe(false);
		expect(scripted.calls).toHaveLength(2);
		expect(requests()).toHaveLength(1);
	});

	it("does not emit on the no-UI error path", async () => {
		const tool = await setupTool();
		await tool.execute("tool-call-id", { question: "Q", options: ["A"] }, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: makeUI(),
		});
		expect(requests()).toHaveLength(0);
	});

	it("does not emit for an already-aborted invocation", async () => {
		const tool = await setupTool();
		const controller = new AbortController();
		controller.abort();
		await tool.execute("tool-call-id", { question: "Q", options: ["A"] }, controller.signal, undefined, {
			hasUI: true,
			mode: "tui",
			cwd: "/tmp/project",
			ui: makeUI(),
		});
		expect(requests()).toHaveLength(0);
	});
});
