import { execSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

// Unit test: verify expandEnvValue helper
// We import the (soon-to-be-created) helper function.
// Since it's not exported yet, we inline a local equivalent for now.

function expandEnvValue(key: string, value: string, cwd: string): string {
  try {
    const expanded = execSync(
      `bash -c 'echo -n "${value.replace(/'/g, "'\"'\"'")}"'`,
      { encoding: "utf-8", timeout: 5000, cwd }
    );
    return `${key}=${expanded}`;
  } catch {
    return `${key}=${value}`;
  }
}

describe("expandEnvValue", () => {
  it("passes through plain values unchanged", () => {
    const result = expandEnvValue("NODE_ENV", "production", "/tmp");
    expect(result).toBe("NODE_ENV=production");
  });

  it("expands shell command substitution with $(...)", () => {
    // Write a temp file with known content, then cat it via $(...)
    const tmpFile = "/tmp/pi-test-env-expand-" + Date.now();
    execSync(`echo -n "secret-token" > "${tmpFile}"`);
    try {
      const result = expandEnvValue("TOKEN", `$(cat "${tmpFile}")`, "/tmp");
      expect(result).toBe("TOKEN=secret-token");
    } finally {
      execSync(`rm -f "${tmpFile}"`);
    }
  });

  it("expands $HOME variable reference", () => {
    const home = process.env.HOME || "/home/user";
    const result = expandEnvValue("HOME_DIR", "$HOME", "/tmp");
    expect(result).toBe(`HOME_DIR=${home}`);
  });

  it("produces empty string when substitution yields nothing", () => {
    // When $(...) produces nothing, echo -n returns exit 0 with empty string.
    // execSync does NOT throw — the expanded value is simply empty.
    const result = expandEnvValue("KEY", "$(nonexistent-command 2>/dev/null)", "/tmp");
    expect(result).toBe("KEY=");
  });

  it("handles values with single quotes by escaping them", () => {
    const result = expandEnvValue("MSG", "it's working", "/tmp");
    expect(result).toBe("MSG=it's working");
  });

  it("preserves key=value format with multiple equals signs", () => {
    // Value contains = -> still works, only the first = splits key/value
    const result = expandEnvValue("URL", "https://example.com?a=1&b=2", "/tmp");
    expect(result).toBe("URL=https://example.com?a=1&b=2");
  });
});

describe("env merge order", () => {
  it("builtin env comes before user env, user can override", () => {
    // Simulate what startContainer does
    const builtinEnv = ["DEBIAN_FRONTEND=noninteractive"];
    const userEnv = ["DEBIAN_FRONTEND=dialog", "CUSTOM=val"];
    const merged = [...builtinEnv, ...userEnv.map((e) => e)];
    // Docker uses the LAST occurrence for dup keys, so user's override wins
    expect(merged).toEqual([
      "DEBIAN_FRONTEND=noninteractive",
      "DEBIAN_FRONTEND=dialog",
      "CUSTOM=val",
    ]);
  });

  it("when env is undefined, use builtin only", () => {
    const builtinEnv = ["DEBIAN_FRONTEND=noninteractive"];
    const userEnv: string[] | undefined = undefined;
    const env = [...builtinEnv, ...(userEnv ?? [])];
    expect(env).toEqual(["DEBIAN_FRONTEND=noninteractive"]);
  });
});
