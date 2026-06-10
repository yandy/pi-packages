import { describe, it, expect } from "vitest";
import { deriveContainerName } from "../src/runtime";

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
