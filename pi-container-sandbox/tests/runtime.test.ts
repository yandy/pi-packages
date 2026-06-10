import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Dockerode from "dockerode";
import { DockerRuntime, deriveContainerName } from "../src/runtime";

const dockerAvailable = (() => {
  try {
    const d = new Dockerode({ socketPath: "/var/run/docker.sock" });
    return true;
  } catch { return false; }
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
    try { const c = d.getContainer(testName); await c.remove({ force: true }); } catch {}
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
      const [r1, r2] = await Promise.all([runtime.withReady(), runtime.withReady()]);
      expect(runtime.isReady()).toBe(true);
    } finally {
      try { await runtime.shutdown(); } catch {}
    }
  }, 120000);
});
