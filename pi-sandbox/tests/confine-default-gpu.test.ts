import { beforeEach, describe, expect, it, vi } from "vitest";

const { discoverGpuDevicesMock } = vi.hoisted(() => ({
	discoverGpuDevicesMock: vi.fn(() => ["/dev/nvidia0"]),
}));
vi.mock("../src/gpu", () => ({ discoverGpuDevices: discoverGpuDevicesMock }));

import { confine } from "../src/confine";

beforeEach(() => {
	discoverGpuDevicesMock.mockClear();
});

describe("confine production GPU discovery", () => {
	it("uses the production GPU discoverer when no hook is provided", () => {
		const result = confine(["true"], "read-only", "/ws", {
			selected: { runner: "bwrap", enforcement: "full" },
		});

		expect(discoverGpuDevicesMock).toHaveBeenCalledOnce();
		expect(result.argv).toEqual([
			"bwrap", "--ro-bind", "/", "/", "--dev", "/dev",
			"--dev-bind-try", "/dev/nvidia0", "/dev/nvidia0",
			"--unshare-pid", "--proc", "/proc", "--die-with-parent", "--", "true",
		]);
	});
});
