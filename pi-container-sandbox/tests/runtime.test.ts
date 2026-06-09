import { describe, it, expect } from "vitest";
import { deriveContainerName, randomSuffix } from "../src/runtime";

describe("deriveContainerName", () => {
  it("generates deterministic name from path", () => {
    const name = deriveContainerName("/home/user/projects/my-app");
    expect(name).toMatch(/^pi-sbx-my-app-[a-f0-9]{6}$/);
  });

  it("same path produces same name", () => {
    const a = deriveContainerName("/home/user/projects/my-app");
    const b = deriveContainerName("/home/user/projects/my-app");
    expect(a).toBe(b);
  });

  it("different paths produce different names", () => {
    const a = deriveContainerName("/home/user/projects/app-a");
    const b = deriveContainerName("/home/user/projects/app-b");
    expect(a).not.toBe(b);
  });

  it("handles trailing slash", () => {
    const a = deriveContainerName("/home/user/projects/my-app/");
    const b = deriveContainerName("/home/user/projects/my-app");
    expect(a).toBe(b);
  });
});

describe("randomSuffix", () => {
  it("returns 8-character hex string", () => {
    const s = randomSuffix();
    expect(s).toMatch(/^[a-f0-9]{8}$/);
  });

  it("returns different values on subsequent calls", () => {
    const a = randomSuffix();
    const b = randomSuffix();
    expect(a).not.toBe(b);
  });
});
