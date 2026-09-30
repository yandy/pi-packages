import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerRuntime } from "../src/runtime";

const dockerAvailable = (() => {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
})();

describe.skipIf(!dockerAvailable)("DockerRuntime container reuse", () => {
	const testName = `pi-test-reuse-${Date.now()}`;

	beforeAll(() => {
		if (!dockerAvailable) return;
		try {
			execFileSync("docker", ["image", "inspect", "debian:12-slim"], { stdio: "ignore" });
		} catch {
			execFileSync("docker", ["pull", "debian:12-slim"], { stdio: "inherit", timeout: 120000 });
		}
	}, 120000);

	afterAll(() => {
		try { execFileSync("docker", ["rm", "-f", testName], { stdio: "ignore" }); } catch {}
		try { execFileSync("docker", ["rm", "-f", `${testName}-stopped`], { stdio: "ignore" }); } catch {}
	});

	it("stopped container is removed and a new one is created", async () => {
		const stoppedName = `${testName}-stopped`;

		try {
			const rt1 = new DockerRuntime({
				image: "debian:12-slim",
				hostCwd: "/tmp",
				name: stoppedName,
				allowNetwork: false,
				resources: { memory: "256m", cpus: "0.5" },
			});
			await rt1.init();
			await rt1.withReady();
			expect(rt1.isReady()).toBe(true);
			const id1 = rt1.getContainerId();

			execFileSync("docker", ["stop", "-t", "5", stoppedName], { stdio: "ignore" });

			const rt2 = new DockerRuntime({
				image: "debian:12-slim",
				hostCwd: "/tmp",
				name: stoppedName,
				allowNetwork: false,
				resources: { memory: "256m", cpus: "0.5" },
			});
			await rt2.init();
			await rt2.withReady();
			expect(rt2.isReady()).toBe(true);

			const id2 = rt2.getContainerId();
			expect(id2).not.toBe(id1);

			await rt2.shutdown();
		} finally {
			try { execFileSync("docker", ["rm", "-f", stoppedName], { stdio: "ignore" }); } catch {}
		}
	}, 120000);

	it("withReady() then a second startContainer() reuses the same running container", async () => {
		const rt1 = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: testName,
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		await rt1.init();
		await rt1.withReady();
		expect(rt1.isReady()).toBe(true);
		const id1 = rt1.getContainerId();

		// 第二个 runtime 实例，同名，应复用已有容器
		const rt2 = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: testName,
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		await rt2.init();
		await rt2.withReady();
		expect(rt2.isReady()).toBe(true);
		const id2 = rt2.getContainerId();
		expect(id2).toBe(id1);

		// 复用不应影响原 runtime 的可用性
		expect(rt1.isReady()).toBe(true);

		// shutdown 停容器
		await rt1.shutdown();
	}, 120000);
});
