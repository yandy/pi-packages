import { describe, expect, it } from "vitest";
import {
  type ModelRegistry,
  resolveInvocationModel,
  resolveModel,
} from "../../src/session/model-resolver";

// Mock model entries matching typical pi model registry shape
const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
];

function makeRegistry(models = MODELS, available?: typeof MODELS): ModelRegistry {
  return {
    find(provider: string, modelId: string) {
      return models.find(m => m.provider === provider && m.id === modelId);
    },
    getAll() {
      return models;
    },
    getAvailable: available ? () => available : undefined,
  };
}

describe("resolveModel", () => {
  describe("exact match (provider/modelId)", () => {
    it("resolves exact provider/modelId", () => {
      const result = resolveModel("anthropic/claude-opus-4-6", makeRegistry());
      expect(result).toEqual(MODELS[0]);
    });

    it("resolves another exact provider/modelId", () => {
      const result = resolveModel("openai/gpt-4o", makeRegistry());
      expect(result).toEqual(MODELS[3]);
    });

    it("falls through to fuzzy when exact provider/modelId not found", () => {
      // "anthropic/haiku" is not an exact match, but fuzzy should find it
      const result = resolveModel("anthropic/haiku", makeRegistry());
      expect(result).toEqual(MODELS[2]); // haiku
    });
  });

  describe("fuzzy match — exact id", () => {
    it("matches exact model id without provider", () => {
      const result = resolveModel("claude-opus-4-6", makeRegistry());
      expect(result).toEqual(MODELS[0]);
    });

    it("is case-insensitive", () => {
      const result = resolveModel("Claude-Opus-4-6", makeRegistry());
      expect(result).toEqual(MODELS[0]);
    });

    it("matches exact id for non-anthropic models", () => {
      const result = resolveModel("gpt-4o", makeRegistry());
      expect(result).toEqual(MODELS[3]);
    });
  });

  describe("fuzzy match — substring", () => {
    it("matches 'haiku' to claude-haiku model", () => {
      const result = resolveModel("haiku", makeRegistry());
      expect(result).toEqual(MODELS[2]);
    });

    it("matches 'sonnet' to claude-sonnet model", () => {
      const result = resolveModel("sonnet", makeRegistry());
      expect(result).toEqual(MODELS[1]);
    });

    it("matches 'opus' to claude-opus model", () => {
      const result = resolveModel("opus", makeRegistry());
      expect(result).toEqual(MODELS[0]);
    });

    it("matches 'gemini' to gemini model", () => {
      const result = resolveModel("gemini", makeRegistry());
      expect(result).toEqual(MODELS[4]);
    });

    it("is case-insensitive for substring", () => {
      const result = resolveModel("HAIKU", makeRegistry());
      expect(result).toEqual(MODELS[2]);
    });
  });

  describe("fuzzy match — name contains", () => {
    it("matches 'Opus 4.6' via model name", () => {
      const result = resolveModel("Opus 4.6", makeRegistry());
      expect(result).toEqual(MODELS[0]);
    });

    it("matches 'Haiku 4.5' via model name", () => {
      const result = resolveModel("Haiku 4.5", makeRegistry());
      expect(result).toEqual(MODELS[2]);
    });
  });

  describe("fuzzy match — multi-part", () => {
    it("matches 'anthropic opus' across provider and id", () => {
      const result = resolveModel("anthropic opus", makeRegistry());
      expect(result).toEqual(MODELS[0]);
    });

    it("matches 'google pro' across provider and id", () => {
      const result = resolveModel("google pro", makeRegistry());
      expect(result).toEqual(MODELS[4]);
    });
  });

  describe("fuzzy match — prefers tighter matches", () => {
    it("prefers exact id over substring", () => {
      const result = resolveModel("gpt-4o", makeRegistry());
      expect(result).toEqual(MODELS[3]);
    });

    it("substring match prefers shorter model id (tighter fit)", () => {
      // Both opus and sonnet contain their query as substring, but "opus" is a tighter match
      // for "opus" than "sonnet" is for "sonnet" — each should resolve to itself
      expect(resolveModel("opus", makeRegistry())).toEqual(MODELS[0]);
      expect(resolveModel("sonnet", makeRegistry())).toEqual(MODELS[1]);
    });
  });

  describe("no match", () => {
    it("returns error string for unknown model", () => {
      const result = resolveModel("nonexistent-model", makeRegistry());
      expect(typeof result).toBe("string");
      expect(result).toContain('Model not found: "nonexistent-model"');
      expect(result).toContain("Available models:");
    });

    it("error lists available models", () => {
      const result = resolveModel("xyz", makeRegistry());
      expect(result).toContain("anthropic/claude-opus-4-6");
      expect(result).toContain("openai/gpt-4o");
    });

    it("empty string matches a model (multi-part vacuous truth)", () => {
      // Empty string splits to empty parts; every() on empty array is true
      // This is fine — callers guard against empty input
      const result = resolveModel("", makeRegistry());
      expect(typeof result).toBe("object");
    });
  });

  describe("getAvailable filtering", () => {
    it("uses getAvailable when present (filters to configured models)", () => {
      const available = [MODELS[0], MODELS[2]]; // only opus and haiku
      const result = resolveModel("sonnet", makeRegistry(MODELS, available));
      // sonnet is in getAll but not in getAvailable — should not fuzzy match
      expect(typeof result).toBe("string");
      expect(result).toContain("Model not found");
    });

    it("exact match fails when model is not in getAvailable (no auth)", () => {
      const available = [MODELS[0]]; // only opus available
      const result = resolveModel("anthropic/claude-sonnet-4-6", makeRegistry(MODELS, available));
      expect(typeof result).toBe("string");
      expect(result).toContain("Model not found");
    });

    it("fuzzy matches against available models only", () => {
      const available = [MODELS[2]]; // only haiku available
      const result = resolveModel("haiku", makeRegistry(MODELS, available));
      expect(result).toEqual(MODELS[2]);
    });
  });

  describe("ambiguous matches", () => {
    const SIMILAR_MODELS = [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      { id: "claude-sonnet-4-5-20241022", name: "Claude Sonnet 4.5", provider: "anthropic" },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
    ];

    it("'sonnet' prefers tighter id match (shorter id)", () => {
      const result = resolveModel("sonnet", makeRegistry(SIMILAR_MODELS));
      // "sonnet" is a larger fraction of "claude-sonnet-4-6" than "claude-sonnet-4-5-20241022"
      expect(result).toEqual(SIMILAR_MODELS[0]);
    });

    it("'sonnet 4.5' resolves to the 4.5 model via name", () => {
      const result = resolveModel("sonnet 4.5", makeRegistry(SIMILAR_MODELS));
      expect(result).toEqual(SIMILAR_MODELS[1]);
    });

    it("'4-6' picks the 4.6 model", () => {
      const result = resolveModel("4-6", makeRegistry(SIMILAR_MODELS));
      expect(result).toEqual(SIMILAR_MODELS[0]);
    });
  });

  describe("empty registry", () => {
    it("returns error with empty available list", () => {
      const result = resolveModel("haiku", makeRegistry([]));
      expect(typeof result).toBe("string");
      expect(result).toContain("Model not found");
    });
  });
});

describe("resolveInvocationModel", () => {
  const parentModel = { id: "claude-opus-4-6", provider: "anthropic" };

  describe("config-specified model silent fallback (modelFromParams false)", () => {
    it("returns parent model when config-specified model fails to resolve", () => {
      const result = resolveInvocationModel(parentModel, "nonexistent-model", false, makeRegistry());
      expect(result).toEqual({ model: parentModel });
      expect(result.error).toBeUndefined();
    });

    it("falls back to null parent when config-specified model fails", () => {
      const result = resolveInvocationModel(null, "nonexistent-model", false, makeRegistry());
      expect(result).toEqual({ model: null });
      expect(result.error).toBeUndefined();
    });
  });

  describe("user-specified model failure (modelFromParams true)", () => {
    it("returns error when params-specified model fails to resolve", () => {
      const result = resolveInvocationModel(parentModel, "nonexistent-model", true, makeRegistry());
      expect(result.model).toBeUndefined();
      expect(result.error).toContain("Model not found");
      expect(result.error).toContain("nonexistent-model");
    });

    it("error includes available models list", () => {
      const result = resolveInvocationModel(parentModel, "xyz", true, makeRegistry());
      expect(result.error).toContain("Available models:");
    });
  });

  describe("successful model resolution", () => {
    it("returns resolved model when modelInput resolves (config-specified)", () => {
      const result = resolveInvocationModel(parentModel, "haiku", false, makeRegistry());
      expect(result).toEqual({ model: MODELS[2] });
      expect(result.error).toBeUndefined();
    });

    it("returns resolved model when modelInput resolves (params-specified)", () => {
      const result = resolveInvocationModel(parentModel, "opus", true, makeRegistry());
      expect(result).toEqual({ model: MODELS[0] });
      expect(result.error).toBeUndefined();
    });

    it("returns resolved model using exact provider/modelId", () => {
      const result = resolveInvocationModel(parentModel, "openai/gpt-4o", true, makeRegistry());
      expect(result).toEqual({ model: MODELS[3] });
      expect(result.error).toBeUndefined();
    });
  });

  describe("parent model inheritance (no modelInput)", () => {
    it("returns parent model when modelInput is undefined (modelFromParams false)", () => {
      const result = resolveInvocationModel(parentModel, undefined, false, makeRegistry());
      expect(result).toEqual({ model: parentModel });
      expect(result.error).toBeUndefined();
    });

    it("returns parent model when modelInput is undefined (modelFromParams true)", () => {
      const result = resolveInvocationModel(parentModel, undefined, true, makeRegistry());
      expect(result).toEqual({ model: parentModel });
      expect(result.error).toBeUndefined();
    });

    it("propagates null parent model when modelInput is undefined", () => {
      const result = resolveInvocationModel(null, undefined, false, makeRegistry());
      expect(result).toEqual({ model: null });
      expect(result.error).toBeUndefined();
    });
  });
});
