/**
 * env.ts — Detect environment info (git, platform) for subagent system prompts.
 */

import { debugLog } from "../debug";
import type { ShellExec } from "../types";

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}

export async function detectEnv(exec: ShellExec, cwd: string): Promise<EnvInfo> {
  let isGitRepo = false;
  let branch = "";

  try {
    const result = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 5000 });
    isGitRepo = result.code === 0 && result.stdout.trim() === "true";
  } catch (err) {
    debugLog("git rev-parse", err);
  }

  if (isGitRepo) {
    try {
      const result = await exec("git", ["branch", "--show-current"], { cwd, timeout: 5000 });
      branch = result.code === 0 ? result.stdout.trim() : "unknown";
    } catch (err) {
      debugLog("git branch", err);
      branch = "unknown";
    }
  }

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}
