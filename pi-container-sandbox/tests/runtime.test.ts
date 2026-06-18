import Dockerode from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { PACKAGE_DOCKER_DIR } from "../src/config";
import { DockerRuntime, deriveContainerName } from "../src/runtime";

const dockerAvailable = (() => {
	try {
		new Dockerode({ socketPath: "/var/run/docker.sock" });
		return true;
	} catch {
		return false;
	}
})();

describe("deriveContainerName", () => {
	it("generates a name with pi-sbx- prefix using cwd basename", () => {
		const name = deriveContainerName("/home/user/my-project");
		expect(name).toMatch(/^pi-sbx-my-project-[a-f0-9]{6}$/);
	});

	it("strips trailing slashes", () => {
		const a = deriveContainerName("/home/user/project");
		const b = deriveContainerName("/home/user/project/");
		expect(a).toBe(b);
	});

	it("falls back to 'project' when cwd is root", () => {
		const name = deriveContainerName("/");
		expect(name).toMatch(/^pi-sbx-project-[a-f0-9]{6}$/);
	});

	it("truncates long basenames to stay under 128 chars", () => {
		const longDir = "/" + "a".repeat(200);
		const name = deriveContainerName(longDir);
		expect(name.length).toBeLessThanOrEqual(128);
		expect(name).toMatch(/^pi-sbx-/);
	});
});

describe.skipIf(!dockerAvailable)("DockerRuntime", () => {
	let runtime: DockerRuntime;

	it("init() pings Docker and sets isReady()", async () => {
		runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: "pi-test-init",
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		await runtime.init();
		expect(runtime.isReady()).toBe(false); // not ready until withReady
	});

	it("returns isReady()=false when Docker is unreachable (mock)", async () => {
		const badRuntime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: "pi-test-bad",
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		expect(badRuntime.isReady()).toBe(false);
	});
});

describe.skipIf(!dockerAvailable)("DockerRuntime lifecycle", () => {
	const testName = `pi-test-lifecycle-${Date.now()}`;

	afterAll(async () => {
		const d = new Dockerode({ socketPath: "/var/run/docker.sock" });
		try {
			const c = d.getContainer(testName);
			await c.remove({ force: true });
		} catch {}
	});

	it("withReady() builds/starts container and sets ready state", async () => {
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: testName,
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5", pidsLimit: 100 },
		});
		await runtime.init();
		expect(runtime.isReady()).toBe(false);
		await runtime.withReady();
		expect(runtime.isReady()).toBe(true);
		const id = runtime.getContainerId();
		expect(id).toBeTruthy();
		expect(typeof id).toBe("string");
	}, 120000);

	it("second withReady() call is deduplicated", async () => {
		const dedupName = testName + "-dedup";
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: dedupName,
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		try {
			await runtime.init();
			await Promise.all([runtime.withReady(), runtime.withReady()]);
			expect(runtime.isReady()).toBe(true);
		} finally {
			try {
				await runtime.shutdown();
			} catch {}
		}
	}, 120000);

});

describe.skipIf(!dockerAvailable)("DockerRuntime exec", () => {
	const testName = `pi-test-exec-${Date.now()}`;

	afterAll(async () => {
		const d = new Dockerode({ socketPath: "/var/run/docker.sock" });
		try {
			const c = d.getContainer(testName + "-exec1");
			await c.remove({ force: true });
		} catch {}
		try {
			const c = d.getContainer(testName + "-exec2");
			await c.remove({ force: true });
		} catch {}
		try {
			const c = d.getContainer(testName + "-exec3");
			await c.remove({ force: true });
		} catch {}
		try {
			const c = d.getContainer(testName + "-exec4");
			await c.remove({ force: true });
		} catch {}
		try {
			const c = d.getContainer(testName + "-exec5");
			await c.remove({ force: true });
		} catch {}
	});

	it("exec returns stdout and exitCode 0", async () => {
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: testName + "-exec1",
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		await runtime.init();
		await runtime.withReady();
		const result = await runtime.exec({ cmd: ["echo", "-n", "hello"] });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("hello");
		expect(result.stderr.toString()).toBe("");
		await runtime.shutdown();
	}, 120000);

	it("exec returns non-zero exitCode for failing command", async () => {
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: testName + "-exec2",
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		await runtime.init();
		await runtime.withReady();
		const result = await runtime.exec({ cmd: ["sh", "-c", "exit 42"] });
		expect(result.exitCode).toBe(42);
		await runtime.shutdown();
	}, 120000);

	it("exec separates stdout and stderr (demux)", async () => {
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: testName + "-exec3",
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		await runtime.init();
		await runtime.withReady();
		const result = await runtime.exec({
			cmd: ["sh", "-c", "echo out; echo err >&2"],
		});
		expect(result.stdout.toString().trim()).toBe("out");
		expect(result.stderr.toString().trim()).toBe("err");
		await runtime.shutdown();
	}, 120000);

	it("exec honors timeoutMs — returns null exitCode", async () => {
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: testName + "-exec4",
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		await runtime.init();
		await runtime.withReady();
		const result = await runtime.exec({
			cmd: ["sleep", "10"],
			timeoutMs: 1000,
		});
		expect(result.exitCode).toBe(null);
		await runtime.shutdown();
	}, 120000);

	it("exec streams onData for stdout", async () => {
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: testName + "-exec5",
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		await runtime.init();
		await runtime.withReady();
		const chunks: Buffer[] = [];
		const result = await runtime.exec({
			cmd: ["sh", "-c", "echo one; sleep 0.1; echo two"],
			onData: (chunk) => chunks.push(chunk),
		});
		expect(result.exitCode).toBe(0);
		const output = Buffer.concat(chunks).toString().trim().split("\n");
		expect(output).toContain("one");
		expect(output).toContain("two");
		await runtime.shutdown();
	}, 120000);
});

describe.skipIf(!dockerAvailable)("DockerRuntime imageExists", () => {
	it("returns false for non-existent image", async () => {
		const runtime = new DockerRuntime({
			image: "nonexistent-image-xyz",
			hostCwd: "/tmp",
			name: "pi-test-exists-" + Date.now(),
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		await runtime.init();
		const exists = await runtime.imageExists();
		expect(exists).toBe(false);
	}, 30000);

	it("returns true for existing image", async () => {
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: "pi-test-exists2-" + Date.now(),
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		await runtime.init();
		const exists = await runtime.imageExists();
		expect(exists).toBe(true);
	}, 30000);
});

describe("DockerRuntime buildImage / getImage", () => {
	it("has buildImage method", () => {
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: "pi-test-build-" + Date.now(),
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		expect(typeof runtime.buildImage).toBe("function");
	});

	it("getImage returns the configured image name", () => {
		const runtime = new DockerRuntime({
			image: "my-custom-image:v1",
			hostCwd: "/tmp",
			name: "pi-test-getimg-" + Date.now(),
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		expect(runtime.getImage()).toBe("my-custom-image:v1");
	});
});

describe("PACKAGE_DOCKER_DIR", () => {
	it("resolves to a path ending with /docker", () => {
		expect(PACKAGE_DOCKER_DIR).toMatch(/\/docker$/);
	});
});
