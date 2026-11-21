import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
	it("returns defaults for an empty env", () => {
		expect(loadConfig({}, "linux")).toEqual({
			enabled: true,
			backend: "notify-send",
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

	it("selects the platform default backend and command", () => {
		expect(loadConfig({}, "linux")).toMatchObject({ backend: "notify-send", command: "notify-send" });
		expect(loadConfig({}, "darwin")).toMatchObject({ backend: "notify-send", command: "notify-send" });
		expect(loadConfig({}, "win32")).toMatchObject({ backend: "windows-toast", command: "powershell.exe" });
	});

	it("marks every explicit command as custom, including built-in names", () => {
		expect(loadConfig({ PI_NOTIFY_COMMAND: "my-notify" }, "win32")).toMatchObject({
			backend: "custom",
			command: "my-notify",
		});
		expect(loadConfig({ PI_NOTIFY_COMMAND: "powershell.exe" }, "win32").backend).toBe("custom");
		expect(loadConfig({ PI_NOTIFY_COMMAND: "notify-send" }, "linux").backend).toBe("custom");
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
		const config = loadConfig(
			{
				PI_NOTIFY_URGENCY_PROMPT: "",
				PI_NOTIFY_URGENCY_DONE: "",
				PI_NOTIFY_COMMAND: "",
			},
			"linux",
		);
		expect(config.urgencyPrompt).toBe("critical");
		expect(config.urgencyDone).toBe("normal");
		expect(config.command).toBe("notify-send");
		expect(config.backend).toBe("notify-send");
	});
});
