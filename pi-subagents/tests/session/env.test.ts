import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectEnv } from "../../src/session/env";
import type { ShellExec } from "../../src/types";

/** ShellExec stub that shells out via child_process. */
function mockExec(): ShellExec {
  return async (command, args, options) => {
    try {
      const stdout = execSync(`${command} ${args.join(" ")}`, {
        cwd: options?.cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: options?.timeout,
      });
      return { stdout, stderr: "", code: 0 };
    } catch (err: any) {
      return { stdout: "", stderr: err.stderr ?? "", code: err.status ?? 1 };
    }
  };
}

describe("detectEnv", () => {
  it("detects git repo in current project", async () => {
    const env = await detectEnv(mockExec(), process.cwd());
    expect(env.isGitRepo).toBe(true);
    expect(env.platform).toBe(process.platform);
  });

  it("returns branch name when on a branch", async () => {
    // Create a temp repo on a known branch to test branch detection
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-env-branch-"));
    try {
      execSync("git init && git config user.email test@test.com && git config user.name Test && git checkout -b test-branch && git commit --allow-empty -m init", {
        cwd: tmpDir, stdio: "pipe",
      });
      const env = await detectEnv(mockExec(), tmpDir);
      expect(env.isGitRepo).toBe(true);
      expect(env.branch).toBe("test-branch");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects non-git directory", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-env-test-"));
    try {
      const env = await detectEnv(mockExec(), tmpDir);
      expect(env.isGitRepo).toBe(false);
      expect(env.branch).toBe("");
      expect(env.platform).toBe(process.platform);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
