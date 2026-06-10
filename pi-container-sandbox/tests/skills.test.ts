import { describe, it, expect, vi } from "vitest";
import { discoverSkillMounts } from "../src/skills";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

describe("discoverSkillMounts", () => {
  it("logs when skipping duplicate mount target", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const base = resolve(tmpdir(), `pi-test-skills-${Date.now()}`);
    const dir1 = resolve(base, "dir1", "skill-a");
    const dir2 = resolve(base, "dir2", "skill-a");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(resolve(dir1, "SKILL.md"), "# Skill A");
    writeFileSync(resolve(dir2, "SKILL.md"), "# Skill A (duplicate)");

    const mounts = discoverSkillMounts([
      resolve(base, "dir1"),
      resolve(base, "dir2"),
    ]);

    expect(mounts.length).toBeGreaterThanOrEqual(1);
    const skipLog = spy.mock.calls.find((c) =>
      c[0]?.includes?.("skipping duplicate mount"),
    );
    expect(skipLog).toBeDefined();

    spy.mockRestore();
    rmSync(base, { recursive: true, force: true });
  });
});
