import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createNotifier } from "../src/notifier.js";

function fakeSpawn() {
	const children: Array<EventEmitter & { unref: ReturnType<typeof vi.fn> }> = [];
	const spawnFn = vi.fn(() => {
		const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
		children.push(child);
		return child;
	});
	return { spawnFn, children };
}

const req = { title: "T", body: "B", urgency: "critical" };

describe("createNotifier", () => {
	it("passes app name and urgency to notify-send", () => {
		const { spawnFn, children } = fakeSpawn();
		const notifier = createNotifier({
			command: "notify-send",
			backend: "notify-send",
			spawnFn: spawnFn as any,
		});
		notifier.notify(req);
		expect(spawnFn).toHaveBeenCalledWith("notify-send", ["-a", "pi", "-u", "critical", "T", "B"], {
			stdio: "ignore",
			windowsHide: true,
		});
		expect(children[0].unref).toHaveBeenCalled();
	});

	it("passes only title and body to a custom command", () => {
		const { spawnFn } = fakeSpawn();
		const notifier = createNotifier({ command: "my-notify", backend: "custom", spawnFn: spawnFn as any });
		notifier.notify(req);
		expect(spawnFn).toHaveBeenCalledWith("my-notify", ["T", "B"], {
			stdio: "ignore",
			windowsHide: true,
		});
	});

	it("keeps an empty body as the last argv", () => {
		const { spawnFn } = fakeSpawn();
		const notifier = createNotifier({ command: "my-notify", backend: "custom", spawnFn: spawnFn as any });
		notifier.notify({ ...req, body: "" });
		expect(spawnFn).toHaveBeenCalledWith("my-notify", ["T", ""], {
			stdio: "ignore",
			windowsHide: true,
		});
	});

	it("uses the PowerShell toast backend on Windows", () => {
		const { spawnFn, children } = fakeSpawn();
		const notifier = createNotifier({
			command: "powershell.exe",
			backend: "windows-toast",
			windowsScriptPath: "C:\\pi-notify\\windows-toast.ps1",
			spawnFn: spawnFn as any,
		});
		notifier.notify(req);
		expect(spawnFn).toHaveBeenCalledWith(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				"C:\\pi-notify\\windows-toast.ps1",
				"-Title",
				"T",
				"-Body",
				"B",
				"-Urgency",
				"critical",
			],
			{ stdio: "ignore", windowsHide: true },
		);
		expect(children[0].unref).toHaveBeenCalled();
	});

	it.each(["my-notify", "notify-send", "powershell.exe"])(
		"keeps explicit custom command %s on the title/body protocol",
		(command) => {
			const { spawnFn } = fakeSpawn();
			const notifier = createNotifier({ command, backend: "custom", spawnFn: spawnFn as any });
			notifier.notify(req);
			expect(spawnFn).toHaveBeenCalledWith(command, ["T", "B"], {
				stdio: "ignore",
				windowsHide: true,
			});
		},
	);

	it("spawns once per notify while healthy", () => {
		const { spawnFn } = fakeSpawn();
		const notifier = createNotifier({
			command: "notify-send",
			backend: "notify-send",
			spawnFn: spawnFn as any,
		});
		notifier.notify(req);
		notifier.notify(req);
		expect(spawnFn).toHaveBeenCalledTimes(2);
		expect(notifier.degraded).toBe(false);
	});

	it("degrades on async spawn error and reports only once", () => {
		const { spawnFn, children } = fakeSpawn();
		const onError = vi.fn();
		const notifier = createNotifier({
			command: "notify-send",
			backend: "notify-send",
			spawnFn: spawnFn as any,
			onError,
		});
		notifier.notify(req);
		children[0].emit("error", new Error("ENOENT"));
		expect(notifier.degraded).toBe(true);
		expect(onError).toHaveBeenCalledTimes(1);
		notifier.notify(req);
		notifier.notify(req);
		expect(spawnFn).toHaveBeenCalledTimes(1);
		children[0].emit("error", new Error("ENOENT"));
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("degrades on synchronous spawn throw without rethrowing", () => {
		const onError = vi.fn();
		const spawnFn = vi.fn(() => {
			throw new Error("bad args");
		});
		const notifier = createNotifier({
			command: "notify-send",
			backend: "notify-send",
			spawnFn: spawnFn as any,
			onError,
		});
		expect(() => notifier.notify(req)).not.toThrow();
		expect(notifier.degraded).toBe(true);
		expect(onError).toHaveBeenCalledTimes(1);
		notifier.notify(req);
		expect(spawnFn).toHaveBeenCalledTimes(1);
	});
});
