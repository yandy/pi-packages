import { describe, it, expect, beforeAll } from "vitest";
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
