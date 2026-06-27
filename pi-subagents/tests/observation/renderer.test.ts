import { describe, expect, it } from "vitest";
import type { NotificationDetails } from "../../src/observation/notification";
import { createNotificationRenderer } from "../../src/observation/renderer";

/** Minimal theme stub — satisfies RendererTheme structurally. */
function stubTheme() {
	return {
		fg: (style: string, text: string) => `[${style}:${text}]`,
		bold: (text: string) => `**${text}**`,
	};
}

function makeDetails(overrides: Partial<NotificationDetails> = {}): NotificationDetails {
	return {
		id: "agent-1",
		description: "Test agent",
		status: "completed",
		toolUses: 3,
		turnCount: 5,
		totalTokens: 1000,
		durationMs: 5000,
		resultPreview: "All done.",
		...overrides,
	};
}

/** Render to a flat string for assertion; uses the public render() API. */
function renderText(result: ReturnType<ReturnType<typeof createNotificationRenderer>>): string {
	expect(result).toBeDefined();
	return result!.render(120).join("\n");
}

describe("createNotificationRenderer", () => {
	it("returns undefined when message has no details", () => {
		const renderer = createNotificationRenderer();
		const result = renderer({ details: undefined }, { expanded: false }, stubTheme());
		expect(result).toBeUndefined();
	});

	it("renders completed status with success icon", () => {
		const renderer = createNotificationRenderer();
		const result = renderer({ details: makeDetails() }, { expanded: false }, stubTheme());
		const text = renderText(result);
		expect(text).toContain("[success:✓]");
		expect(text).toContain("**Test agent**");
		expect(text).toContain("completed");
	});

	it("renders error status with error icon", () => {
		const renderer = createNotificationRenderer();
		const result = renderer({ details: makeDetails({ status: "error" }) }, { expanded: false }, stubTheme());
		const text = renderText(result);
		expect(text).toContain("[error:✗]");
		expect(text).toContain("error");
	});

	it("renders steered status as completed (steered)", () => {
		const renderer = createNotificationRenderer();
		const result = renderer({ details: makeDetails({ status: "steered" }) }, { expanded: false }, stubTheme());
		expect(renderText(result)).toContain("completed (steered)");
	});

	it("shows full result lines when expanded", () => {
		const renderer = createNotificationRenderer();
		const result = renderer(
			{ details: makeDetails({ resultPreview: "line1\nline2\nline3" }) },
			{ expanded: true },
			stubTheme(),
		);
		const text = renderText(result);
		expect(text).toContain("line1");
		expect(text).toContain("line2");
		expect(text).toContain("line3");
	});

	it("shows collapsed preview when not expanded", () => {
		const renderer = createNotificationRenderer();
		const result = renderer(
			{ details: makeDetails({ resultPreview: "short result" }) },
			{ expanded: false },
			stubTheme(),
		);
		expect(renderText(result)).toContain("⎿");
		expect(renderText(result)).toContain("short result");
	});

	it("shows output file link when present", () => {
		const renderer = createNotificationRenderer();
		const result = renderer(
			{ details: makeDetails({ outputFile: "/tmp/transcript.jsonl" }) },
			{ expanded: false },
			stubTheme(),
		);
		expect(renderText(result)).toContain("/tmp/transcript.jsonl");
	});

	it("includes stats line with tool uses and tokens", () => {
		const renderer = createNotificationRenderer();
		const result = renderer(
			{ details: makeDetails({ toolUses: 7, totalTokens: 5000 }) },
			{ expanded: false },
			stubTheme(),
		);
		const text = renderText(result);
		expect(text).toContain("7 tool uses");
		expect(text).toContain("5.0k token");
	});
});
