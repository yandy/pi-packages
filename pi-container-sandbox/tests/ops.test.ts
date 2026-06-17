import { describe, it, expect } from "vitest";
import { createWriteOps, createEditOps, execCapture, extractCommandName } from "../src/ops";
import type { MountSpec } from "../src/runtime";
import { mockRuntime } from "./_helpers";

describe("execCapture", () => {
  it("throws when exec returns non-zero exitCode", async () => {
    const runtime = mockRuntime({
      exec: async () => ({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("command not found") }),
    });
    const sbx = { runtime, name: "test", hostCwd: "/tmp", mounts: [], allowedExternalPrefixes: [] };

    await expect(execCapture(sbx, "nonexistent-cmd")).rejects.toThrow("exec failed (1): command not found");
  });

  it("returns stdout when exitCode is 0", async () => {
    const runtime = mockRuntime({
      exec: async () => ({ exitCode: 0, stdout: Buffer.from("hello world"), stderr: Buffer.alloc(0) }),
    });
    const sbx = { runtime, name: "test", hostCwd: "/tmp", mounts: [], allowedExternalPrefixes: [] };

    const result = await execCapture(sbx, "echo hello");
    expect(result.toString()).toBe("hello world");
  });
});

describe("createWriteOps.writeFile", () => {
  it("calls mkdir -p before writing to create parent dirs", async () => {
    const calls: string[] = [];
    const runtime = mockRuntime();
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

  it("rejects write to read-only mount", async () => {
    const mounts: MountSpec[] = [{ source: "/host/skills", target: "/skills/my-skill" }];
    const runtime = mockRuntime();
    const ops = createWriteOps({
      runtime, name: "test", hostCwd: "/home/user/project", mounts, allowedExternalPrefixes: [],
    });

    await expect(ops.writeFile("/skills/my-skill/SKILL.md", "data"))
      .rejects.toThrow("refusing to write");
  });
});

describe("createWriteOps.mkdir", () => {
  it("rejects mkdir in read-only mount", async () => {
    const mounts: MountSpec[] = [{ source: "/host/skills", target: "/skills/my-skill" }];
    const runtime = mockRuntime();
    const ops = createWriteOps({
      runtime, name: "test", hostCwd: "/home/user/project", mounts, allowedExternalPrefixes: [],
    });

    await expect(ops.mkdir("/skills/my-skill/subdir"))
      .rejects.toThrow("refusing to mkdir");
  });
});

describe("createEditOps.writeFile", () => {
  it("rejects write to read-only mount with createWriteOps error message", async () => {
    const mounts: MountSpec[] = [{ source: "/host/skills", target: "/skills/my-skill" }];
    const runtime = mockRuntime();
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

describe("extractCommandName", () => {
  it("extracts simple command", () => {
    expect(extractCommandName("git status")).toBe("git");
  });

  it("extracts single word", () => {
    expect(extractCommandName("npm")).toBe("npm");
  });

  it("trims leading whitespace", () => {
    expect(extractCommandName("  git add .")).toBe("git");
  });

  it("skips env assignments", () => {
    expect(extractCommandName("GIT_DIR=foo git log")).toBe("git");
  });

  it("skips multiple env assignments", () => {
    expect(extractCommandName("A=1 B=2 git log")).toBe("git");
  });

  it("returns full path commands", () => {
    expect(extractCommandName("/usr/bin/node --version")).toBe("/usr/bin/node");
  });

  it("returns null for empty command", () => {
    expect(extractCommandName("")).toBeNull();
  });

  it("returns null for whitespace-only command", () => {
    expect(extractCommandName("   ")).toBeNull();
  });

  it("returns null for env-only (no command)", () => {
    expect(extractCommandName("FOO=bar")).toBeNull();
  });
});

import { createHostBashOps } from "../src/ops";

describe("createHostBashOps", () => {
  it("returns BashOperations with exec function", () => {
    const ops = createHostBashOps("/home/user/project", []);
    expect(typeof ops.exec).toBe("function");
  });

  it("executes a command on host", async () => {
    const ops = createHostBashOps(process.cwd(), []);
    const chunks: Buffer[] = [];
    const result = await ops.exec("echo hello", process.cwd(), {
      onData: (b) => chunks.push(b),
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString().trim()).toBe("hello");
  });
});
