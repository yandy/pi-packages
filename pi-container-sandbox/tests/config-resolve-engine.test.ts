import { describe, expect, it, vi } from "vitest";

// resolveEngine 显式 engine 的可用性契约依赖 container-cli 探测（podman/docker info）。
// mock 掉探测边界后，成功/失败两个方向都能在任何机器上验证——真实探测的耗时
// （冷启动可超 5s）曾使模块加载期的可用性守卫与实现内部 30s 超时判定不一致，
// 导致「守卫认为不可用、被测代码却成功」的 CI 失败。
const containerMock = vi.hoisted(() => vi.fn());

vi.mock("../src/container-cli", () => ({
	container: containerMock,
	containerSpawn: vi.fn(),
}));

import { resolveEngine } from "../src/config";

describe("resolveEngine — explicit engine availability contract", () => {
	it("returns the engine when its probe succeeds", () => {
		containerMock.mockImplementation(() => "");
		expect(resolveEngine("podman")).toBe("podman");
		expect(resolveEngine("docker")).toBe("docker");
		expect(containerMock).toHaveBeenCalledWith("podman", ["info"]);
		expect(containerMock).toHaveBeenCalledWith("docker", ["info"]);
	});

	it("throws a not-available error when the probe fails", () => {
		containerMock.mockImplementation(() => {
			throw new Error("Cannot connect to the container daemon");
		});
		expect(() => resolveEngine("podman")).toThrow(/Container runtime "podman" is not available/);
		expect(() => resolveEngine("docker")).toThrow(/Container runtime "docker" is not available/);
	});

	it("auto delegates to detectEngine instead of probing a fixed binary", () => {
		containerMock.mockImplementation(() => "");
		expect(["docker", "podman"]).toContain(resolveEngine("auto"));
	});
});
