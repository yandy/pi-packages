import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import { defaultProbeBwrap } from "../src/runners";

beforeEach(() => {
	spawnSyncMock.mockReset();
	spawnSyncMock.mockReturnValue({ status: 0 });
});

describe("defaultProbeBwrap", () => {
	it("probes --dev-bind-try support with /dev/null instead of discovered GPUs", () => {
		expect(defaultProbeBwrap(123)).toBe(true);

		expect(spawnSyncMock).toHaveBeenCalledWith("bwrap", [
			"--ro-bind", "/", "/", "--dev", "/dev",
			"--dev-bind-try", "/dev/null", "/dev/null",
			"--unshare-pid", "--proc", "/proc", "--die-with-parent", "--", "true",
		], {
			timeout: 123,
			stdio: "ignore",
		});
	});
});
