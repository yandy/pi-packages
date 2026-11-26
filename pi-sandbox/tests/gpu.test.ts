import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverGpuDevices } from "../src/gpu";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gpu-devices-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function file(name: string): void {
	writeFileSync(join(dir, name), "");
}

describe("discoverGpuDevices", () => {
	it("returns every supported device path in stable sorted order", () => {
		for (const name of ["nvidiactl", "nvidia2", "nvidia-uvm-tools", "dxg", "nvidia10", "kfd", "nvidia-uvm", "nvidia-modeset", "nvidia0"]) {
			file(name);
		}
		mkdirSync(join(dir, "nvidia-caps"));
		mkdirSync(join(dir, "dri"));

		expect(discoverGpuDevices(dir)).toEqual([
			join(dir, "dri"),
			join(dir, "dxg"),
			join(dir, "kfd"),
			join(dir, "nvidia-caps"),
			join(dir, "nvidia-modeset"),
			join(dir, "nvidia-uvm"),
			join(dir, "nvidia-uvm-tools"),
			join(dir, "nvidia0"),
			join(dir, "nvidia10"),
			join(dir, "nvidia2"),
			join(dir, "nvidiactl"),
		]);
	});

	it("rejects names that merely resemble GPU devices", () => {
		for (const name of ["nvidia", "nvidia0-extra", "nvidiax", "kfd0", "dri0", "dxg0"]) file(name);

		expect(discoverGpuDevices(dir)).toEqual([]);
	});

	it("returns an empty list for an empty or unreadable device root", () => {
		expect(discoverGpuDevices(dir)).toEqual([]);
		expect(discoverGpuDevices(join(dir, "missing"))).toEqual([]);
	});
});
