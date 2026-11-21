import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createNotifier } from "../src/notifier.js";

const SPAWN_OPTS = { stdio: ["ignore", "ignore", "pipe"], windowsHide: true };

type FakeChild = EventEmitter & {
	unref: ReturnType<typeof vi.fn>;
	stderr: EventEmitter & { unref: ReturnType<typeof vi.fn>; setEncoding: ReturnType<typeof vi.fn> };
};

function fakeSpawn() {
	const children: FakeChild[] = [];
	const spawnFn = vi.fn(() => {
		const child = Object.assign(new EventEmitter(), {
			unref: vi.fn(),
			stderr: Object.assign(new EventEmitter(), { unref: vi.fn(), setEncoding: vi.fn() }),
		});
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
		expect(spawnFn).toHaveBeenCalledWith("notify-send", ["-a", "pi", "-u", "critical", "T", "B"], SPAWN_OPTS);
		expect(children[0].unref).toHaveBeenCalled();
	});

	it("passes only title and body to a custom command", () => {
		const { spawnFn } = fakeSpawn();
		const notifier = createNotifier({ command: "my-notify", backend: "custom", spawnFn: spawnFn as any });
		notifier.notify(req);
		expect(spawnFn).toHaveBeenCalledWith("my-notify", ["T", "B"], SPAWN_OPTS);
	});

	it("keeps an empty body as the last argv", () => {
		const { spawnFn } = fakeSpawn();
		const notifier = createNotifier({ command: "my-notify", backend: "custom", spawnFn: spawnFn as any });
		notifier.notify({ ...req, body: "" });
		expect(spawnFn).toHaveBeenCalledWith("my-notify", ["T", ""], SPAWN_OPTS);
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
			SPAWN_OPTS,
		);
		expect(children[0].unref).toHaveBeenCalled();
	});

	it.each(["my-notify", "notify-send", "powershell.exe"])(
		"keeps explicit custom command %s on the title/body protocol",
		(command) => {
			const { spawnFn } = fakeSpawn();
			const notifier = createNotifier({ command, backend: "custom", spawnFn: spawnFn as any });
			notifier.notify(req);
			expect(spawnFn).toHaveBeenCalledWith(command, ["T", "B"], SPAWN_OPTS);
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

	it("releases the stderr pipe so the helper cannot keep the host alive", () => {
		const { spawnFn, children } = fakeSpawn();
		const notifier = createNotifier({
			command: "notify-send",
			backend: "notify-send",
			spawnFn: spawnFn as any,
		});
		notifier.notify(req);
		expect(children[0].stderr.unref).toHaveBeenCalled();
	});

	it("reports a helper that exits non-zero with its stderr, once", () => {
		const { spawnFn, children } = fakeSpawn();
		const onError = vi.fn();
		const notifier = createNotifier({
			command: "notify-send",
			backend: "notify-send",
			spawnFn: spawnFn as any,
			onError,
		});
		notifier.notify(req);
		children[0].stderr.emit("data", "Collection was modified\n");
		children[0].emit("close", 1);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0]).toBe(
			"pi-notify: notification helper notify-send exited with code 1: Collection was modified",
		);

		notifier.notify(req);
		children[1].emit("close", 1);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("keeps notifying after a helper exit failure", () => {
		const { spawnFn, children } = fakeSpawn();
		const onError = vi.fn();
		const notifier = createNotifier({
			command: "notify-send",
			backend: "notify-send",
			spawnFn: spawnFn as any,
			onError,
		});
		notifier.notify(req);
		children[0].emit("close", 1);
		expect(notifier.degraded).toBe(false);
		notifier.notify(req);
		children[1].emit("close", 0);
		expect(spawnFn).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("stays silent when the helper exits cleanly", () => {
		const { spawnFn, children } = fakeSpawn();
		const onError = vi.fn();
		const notifier = createNotifier({
			command: "notify-send",
			backend: "notify-send",
			spawnFn: spawnFn as any,
			onError,
		});
		notifier.notify(req);
		children[0].emit("close", 0);
		expect(onError).not.toHaveBeenCalled();
		expect(notifier.degraded).toBe(false);
	});

	it("reports a spawn failure once even though it closes with no exit status", () => {
		const { spawnFn, children } = fakeSpawn();
		const onError = vi.fn();
		const notifier = createNotifier({
			command: "notify-send",
			backend: "notify-send",
			spawnFn: spawnFn as any,
			onError,
		});
		notifier.notify(req);
		children[0].emit("error", new Error("spawn notify-send ENOENT"));
		children[0].emit("close", null);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0]).toContain("spawn failure");
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
