import { afterEach, describe, expect, it, vi } from "vitest";
import { captureWarn } from "../helpers/capture-warn";

describe("captureWarn", () => {
	afterEach(() => {
		vi.restoreAllMocks();
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
