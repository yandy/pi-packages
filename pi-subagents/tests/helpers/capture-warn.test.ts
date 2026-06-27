import { afterEach, describe, expect, it, vi } from "vitest";
import { captureWarn } from "../helpers/capture-warn";

describe("captureWarn", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the stringified first argument of each console.warn call", () => {
    const warnings = captureWarn(() => {
      console.warn("first");
      console.warn("second");
    });
    expect(warnings).toEqual(["first", "second"]);
  });

  it("returns an empty array when nothing warns", () => {
    expect(captureWarn(() => {})).toEqual([]);
  });

  it("restores console.warn even when run throws", () => {
    expect(() =>
      captureWarn(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    console.warn("after");
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
