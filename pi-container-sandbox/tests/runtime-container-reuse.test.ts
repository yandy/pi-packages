import Dockerode from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerRuntime } from "../src/runtime";

const dockerAvailable = (() => {
	try {
		new Dockerode({ socketPath: "/var/run/docker.sock" });
		return true;
	} catch {
		return false;
	}
})();

describe.skipIf(!dockerAvailable)("DockerRuntime container reuse", () => {
	const testName = `pi-test-reuse-${Date.now()}`;

	beforeAll(async () => {
		const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });
		try {
			await docker.getImage("debian:12-slim").inspect();
		} catch {
			await new Promise<void>((resolve, reject) => {
				docker.pull("debian:12-slim", {}, (err, stream) => {
					if (err) return reject(err);
					if (!stream) return reject(new Error("no pull stream"));
					docker.modem.followProgress(stream, (err2) => {
						if (err2) reject(err2 instanceof Error ? err2 : new Error(String(err2)));
						else resolve();
					});
				});
			});
		}
	}, 120000);

	afterAll(async () => {
		const d = new Dockerode({ socketPath: "/var/run/docker.sock" });
		try {
			const c = d.getContainer(testName);
			await c.remove({ force: true });
		} catch {}
		try {
			const c = d.getContainer(testName + "-stopped");
			await c.remove({ force: true });
		} catch {}
	});

	it("stopped container is removed and a new one is created", async () => {
		const stoppedName = testName + "-stopped";
		const d = new Dockerode({ socketPath: "/var/run/docker.sock" });

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

			await d.getContainer(stoppedName).stop({ t: 5 });

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
			try {
				const c = d.getContainer(stoppedName);
				await c.remove({ force: true });
			} catch {}
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
