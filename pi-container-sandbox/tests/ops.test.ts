import { describe, it, expect } from "vitest";
import { createWriteOps, createEditOps } from "../src/ops";
import type { MountSpec, Runtime, ExecOpts, ExecResult } from "../src/runtime";

function mockRuntime(execResults: Record<string, ExecResult>): Runtime {
  return {
    init: async () => {},
    isReady: () => true,
    ensureImage: async () => {},
    rebuildImage: async () => {},
    startContainer: async () => {},
    withReady: async () => {},
    shutdown: async () => {},
    getContainerId: () => "mock-id",
    getWorkRoot: () => "/workspace",
    async exec(opts: ExecOpts): Promise<ExecResult> {
      const key = opts.cmd.join(" ");
      if (execResults[key]) return execResults[key];
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  };
}

describe("createWriteOps.writeFile", () => {
  it("calls mkdir -p before writing to create parent dirs", async () => {
    const calls: string[] = [];
    const runtime = mockRuntime({});
    const origExec = runtime.exec.bind(runtime);
    runtime.exec = async (opts) => {
      calls.push(opts.cmd.join(" "));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };

    const ops = createWriteOps({
      runtime,
      name: "test",
      hostCwd: "/home/user/project",
      mounts: [],
      allowedExternalPrefixes: [],
    });

    await ops.writeFile("sub/deep/file.txt", "content");

    const mkdirCall = calls.find((c) => c.startsWith("sh -c mkdir -p"));
    const writeCall = calls.find((c) => c.includes("base64"));
    expect(mkdirCall).toBeDefined();
    expect(mkdirCall).toContain("/workspace/sub/deep");
    expect(writeCall).toBeDefined();
    expect(writeCall).toContain("/workspace/sub/deep/file.txt");
  });
});

describe("createEditOps.writeFile", () => {
  it("rejects write to read-only mount with createWriteOps error message", async () => {
    const mounts: MountSpec[] = [{ source: "/host/skills", target: "/skills/my-skill" }];
    const calls: string[] = [];
    const runtime = {
      init: async () => {},
      isReady: () => true,
      ensureImage: async () => {},
      rebuildImage: async () => {},
      startContainer: async () => {},
      withReady: async () => {},
      shutdown: async () => {},
      getContainerId: () => "mock-id",
      getWorkRoot: () => "/workspace",
      exec: async (opts: any) => { calls.push(opts.cmd.join(" ")); return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; },
    };

    const ops = createEditOps({
      runtime,
      name: "test",
      hostCwd: "/home/user/project",
      mounts,
      allowedExternalPrefixes: [],
    });

    await expect(
      ops.writeFile("/skills/my-skill/SKILL.md", "content")
    ).rejects.toThrow("refusing to write");
  });
});
