import { describe, expect, it, test } from "vitest";

import {
  getNonEmptyString,
  isDenyWithReason,
  isPermissionState,
  normalizeOptionalPositiveInt,
  normalizeOptionalStringArray,
  toRecord,
} from "../src/value-guards";

describe("toRecord", () => {
  test("returns empty object for null", () => {
    expect(toRecord(null)).toEqual({});
  });

  test("returns empty object for undefined", () => {
    expect(toRecord(undefined)).toEqual({});
  });

  test("returns empty object for a string", () => {
    expect(toRecord("hello")).toEqual({});
  });

  test("returns empty object for a number", () => {
    expect(toRecord(42)).toEqual({});
  });

  test("returns empty object for an array", () => {
    expect(toRecord(["a", "b"])).toEqual({});
  });

  test("returns the object itself for a plain object", () => {
    const input = { a: 1, b: "two" };
    expect(toRecord(input)).toBe(input);
  });

  test("returns the object for a nested object", () => {
    const input = { x: { y: 3 } };
    expect(toRecord(input)).toBe(input);
  });
});

describe("getNonEmptyString", () => {
  test("returns null for non-string values", () => {
    expect(getNonEmptyString(null)).toBeNull();
    expect(getNonEmptyString(undefined)).toBeNull();
    expect(getNonEmptyString(42)).toBeNull();
    expect(getNonEmptyString({})).toBeNull();
    expect(getNonEmptyString([])).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(getNonEmptyString("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(getNonEmptyString("   ")).toBeNull();
    expect(getNonEmptyString("\t\n")).toBeNull();
  });

  test("returns trimmed string for valid string", () => {
    expect(getNonEmptyString("hello")).toBe("hello");
    expect(getNonEmptyString("  hello  ")).toBe("hello");
  });

  test("returns single non-whitespace character", () => {
    expect(getNonEmptyString("a")).toBe("a");
  });
});

describe("isPermissionState", () => {
  test("returns true for 'allow'", () => {
    expect(isPermissionState("allow")).toBe(true);
  });

  test("returns true for 'deny'", () => {
    expect(isPermissionState("deny")).toBe(true);
  });

  test("returns true for 'ask'", () => {
    expect(isPermissionState("ask")).toBe(true);
  });

  test("returns false for unrecognized strings", () => {
    expect(isPermissionState("ALLOW")).toBe(false);
    expect(isPermissionState("permit")).toBe(false);
    expect(isPermissionState("")).toBe(false);
    expect(isPermissionState("block")).toBe(false);
  });

  test("returns false for non-string types", () => {
    expect(isPermissionState(null)).toBe(false);
    expect(isPermissionState(undefined)).toBe(false);
    expect(isPermissionState(1)).toBe(false);
    expect(isPermissionState({})).toBe(false);
  });
});

describe("isDenyWithReason", () => {
  test("returns true for { action: 'deny' } without a reason", () => {
    expect(isDenyWithReason({ action: "deny" })).toBe(true);
  });

  test("returns true for { action: 'deny', reason: '...' }", () => {
    expect(isDenyWithReason({ action: "deny", reason: "Use pnpm" })).toBe(true);
  });

  test("returns false for non-deny actions", () => {
    expect(isDenyWithReason({ action: "allow" })).toBe(false);
    expect(isDenyWithReason({ action: "ask" })).toBe(false);
  });

  test("returns false for a non-string reason", () => {
    expect(isDenyWithReason({ action: "deny", reason: 42 })).toBe(false);
    expect(isDenyWithReason({ action: "deny", reason: null })).toBe(false);
  });

  test("returns false for non-object types", () => {
    expect(isDenyWithReason(null)).toBe(false);
    expect(isDenyWithReason(undefined)).toBe(false);
    expect(isDenyWithReason("deny")).toBe(false);
    expect(isDenyWithReason(["deny"])).toBe(false);
  });
});

describe("normalizeOptionalStringArray", () => {
  it("returns the array for a valid string array", () => {
    expect(normalizeOptionalStringArray(["a", "b", "c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("returns an empty array for an empty array", () => {
    expect(normalizeOptionalStringArray([])).toEqual([]);
  });

  it("returns undefined for a plain string", () => {
    expect(normalizeOptionalStringArray("x")).toBeUndefined();
  });

  it("returns undefined for a number", () => {
    expect(normalizeOptionalStringArray(42)).toBeUndefined();
  });

  it("returns undefined for a plain object", () => {
    expect(normalizeOptionalStringArray({ a: "b" })).toBeUndefined();
  });

  it("returns undefined for a mixed-type array", () => {
    expect(normalizeOptionalStringArray(["a", 1])).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(normalizeOptionalStringArray(undefined)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(normalizeOptionalStringArray(null)).toBeUndefined();
  });
});

describe("normalizeOptionalPositiveInt", () => {
  it("returns the value for a valid positive integer", () => {
    expect(normalizeOptionalPositiveInt(1)).toBe(1);
    expect(normalizeOptionalPositiveInt(200)).toBe(200);
    expect(normalizeOptionalPositiveInt(9999)).toBe(9999);
  });

  it("returns undefined for zero", () => {
    expect(normalizeOptionalPositiveInt(0)).toBeUndefined();
  });

  it("returns undefined for negative integers", () => {
    expect(normalizeOptionalPositiveInt(-1)).toBeUndefined();
    expect(normalizeOptionalPositiveInt(-100)).toBeUndefined();
  });

  it("returns undefined for non-integer numbers (floats)", () => {
    expect(normalizeOptionalPositiveInt(400.5)).toBeUndefined();
    expect(normalizeOptionalPositiveInt(1.1)).toBeUndefined();
  });

  it("returns undefined for non-number types", () => {
    expect(normalizeOptionalPositiveInt("200")).toBeUndefined();
    expect(normalizeOptionalPositiveInt(true)).toBeUndefined();
    expect(normalizeOptionalPositiveInt(null)).toBeUndefined();
    expect(normalizeOptionalPositiveInt(undefined)).toBeUndefined();
    expect(normalizeOptionalPositiveInt({})).toBeUndefined();
  });
});
