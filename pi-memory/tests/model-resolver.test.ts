import { describe, it, expect, vi } from "vitest";
import { resolveModel } from "../src/model-resolver";

describe("resolveModel", () => {
  it("returns undefined for empty registry", () => {
    const registry = { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) };
    expect(resolveModel("deepseek/deepseek-v4-flash", registry as any)).toBeUndefined();
  });

  it("exact match by provider/modelId", () => {
    const model = { provider: "deepseek", id: "deepseek-v4-flash" };
    const registry = {
      find: vi.fn().mockReturnValue(model),
      getAvailable: vi.fn().mockReturnValue([{ provider: "deepseek", id: "deepseek-v4-flash" }]),
    };
    expect(resolveModel("deepseek/deepseek-v4-flash", registry as any)).toBe(model);
  });

  it("returns undefined when exact match found but not in available set", () => {
    const model = { provider: "deepseek", id: "deepseek-v4-flash" };
    const registry = {
      find: vi.fn().mockReturnValue(model),
      getAvailable: vi.fn().mockReturnValue([{ provider: "openai", id: "gpt-4" }]),
    };
    expect(resolveModel("deepseek/deepseek-v4-flash", registry as any)).toBeUndefined();
  });

  it("fuzzy match by name fragment", () => {
    const model = { provider: "deepseek", id: "deepseek-v4-flash" };
    const registry = {
      find: vi.fn().mockReturnValue(undefined),
      getAvailable: vi.fn().mockReturnValue([
        { provider: "deepseek", id: "deepseek-v4-flash" },
        { provider: "openai", id: "gpt-4" },
      ]),
    };
    expect(resolveModel("deepseek-v4", registry as any)).toStrictEqual(model);
  });

  it("returns undefined when fuzzy match score below threshold", () => {
    const registry = {
      find: vi.fn().mockReturnValue(undefined),
      getAvailable: vi.fn().mockReturnValue([
        { provider: "deepseek", id: "deepseek-v4-flash" },
      ]),
    };
    expect(resolveModel("nonexistent", registry as any)).toBeUndefined();
  });

  it("no slash in query → fuzzy match only", () => {
    const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const registry = {
      find: vi.fn(),
      getAvailable: vi.fn().mockReturnValue([
        { provider: "anthropic", id: "claude-sonnet-4-5" },
      ]),
    };
    expect(resolveModel("sonnet-4", registry as any)).toStrictEqual(model);
  });
});
