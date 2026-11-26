import { readdirSync } from "node:fs";
import { join } from "node:path";

const GPU_DEVICE_NAMES = new Set([
	"dri",
	"dxg",
	"kfd",
	"nvidia-caps",
	"nvidia-modeset",
	"nvidia-uvm",
	"nvidia-uvm-tools",
	"nvidiactl",
]);
const NVIDIA_CARD_NAME = /^nvidia\d+$/;

/** Return the currently visible GPU device paths without recursive scanning. */
export function discoverGpuDevices(devRoot = "/dev"): string[] {
	try {
		return readdirSync(devRoot)
			.filter((name) => GPU_DEVICE_NAMES.has(name) || NVIDIA_CARD_NAME.test(name))
			.sort()
			.map((name) => join(devRoot, name));
	} catch {
		return [];
	}
}
