import { describe, expect, it, vi } from "vitest";

// init() 通过 container-cli 的 execFileSync 探测 runtime。mock 掉它，
// 使「探测失败」分支在任何机器上（无论是否装有 docker/podman）都可验证。
vi.mock("../src/container-cli", () => ({
	container: vi.fn(() => {
		throw new Error("Cannot connect to the container daemon");
	}),
	containerSpawn: vi.fn(),
}));

import { DockerRuntime, PodmanRuntime } from "../src/runtime";

function opts(name: string) {
	return {
		image: "debian:12-slim",
		hostCwd: "/tmp",
		name,
		allowNetwork: false,
		resources: { memory: "256m", cpus: "0.5" },
	};
}

describe("Runtime init failure (daemon unreachable)", () => {
	it("DockerRuntime init does not throw and stays not-ready when docker is unreachable", async () => {
		const rt = new DockerRuntime(opts("init-fail-docker"));
		await expect(rt.init()).resolves.toBeUndefined();
		expect(rt.isReady()).toBe(false);
		expect(rt.getContainerId()).toBeNull();
	});

	it("PodmanRuntime init does not throw and stays not-ready when podman is unreachable", async () => {
		const rt = new PodmanRuntime(opts("init-fail-podman"));
		await expect(rt.init()).resolves.toBeUndefined();
		expect(rt.isReady()).toBe(false);
		expect(rt.getContainerId()).toBeNull();
	});
});
