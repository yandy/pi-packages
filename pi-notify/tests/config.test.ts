import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
	it("returns defaults for an empty env", () => {
		expect(loadConfig({})).toEqual({
			enabled: true,
			minDurationMs: 10000,
			urgencyPrompt: "critical",
			urgencyDone: "normal",
			command: "notify-send",
		});
	});

	it.each(["0", "false", "FALSE"])("disables when PI_NOTIFY is %j", (value) => {
		expect(loadConfig({ PI_NOTIFY: value }).enabled).toBe(false);
	});

	it.each(["1", "", "yes"])("keeps enabled when PI_NOTIFY is %j", (value) => {
		expect(loadConfig({ PI_NOTIFY: value }).enabled).toBe(true);
	});

	it.each([
		["5000", 5000],
		["0", 0],
		["abc", 10000],
		["-1", 10000],
		["", 10000],
	])("parses PI_NOTIFY_MIN_DURATION_MS %j as %d", (value, expected) => {
		expect(loadConfig({ PI_NOTIFY_MIN_DURATION_MS: value }).minDurationMs).toBe(expected);
	});

	it("overrides urgency and command", () => {
		const config = loadConfig({
			PI_NOTIFY_URGENCY_PROMPT: "low",
			PI_NOTIFY_URGENCY_DONE: "critical",
			PI_NOTIFY_COMMAND: "my-notify",
		});
		expect(config.urgencyPrompt).toBe("low");
		expect(config.urgencyDone).toBe("critical");
		expect(config.command).toBe("my-notify");
	});

	it("falls back to defaults for empty urgency and command", () => {
		const config = loadConfig({
			PI_NOTIFY_URGENCY_PROMPT: "",
			PI_NOTIFY_URGENCY_DONE: "",
			PI_NOTIFY_COMMAND: "",
		});
		expect(config.urgencyPrompt).toBe("critical");
		expect(config.urgencyDone).toBe("normal");
		expect(config.command).toBe("notify-send");
	});
});
