import { describe, expect, it } from "vitest";

import { normalizePermissionSystemConfig } from "../src/extension-config";

describe("normalizePermissionSystemConfig", () => {
	it("normalizes a valid config object", () => {
		const result = normalizePermissionSystemConfig({
			debugLog: true,
			permissionReviewLog: false,
			yoloMode: true,
		});
		expect(result).toEqual({
			debugLog: true,
			permissionReviewLog: false,
			yoloMode: true,
		});
	});

	it("defaults debugLog to false when missing", () => {
		const result = normalizePermissionSystemConfig({});
		expect(result.debugLog).toBe(false);
	});

	it("defaults permissionReviewLog to true when missing", () => {
		const result = normalizePermissionSystemConfig({});
		expect(result.permissionReviewLog).toBe(true);
	});

	it("defaults yoloMode to false when missing", () => {
		const result = normalizePermissionSystemConfig({});
		expect(result.yoloMode).toBe(false);
	});

	it("includes toolInputPreviewMaxLength when a valid positive integer is provided", () => {
		const result = normalizePermissionSystemConfig({
			toolInputPreviewMaxLength: 400,
		});
		expect(result.toolInputPreviewMaxLength).toBe(400);
	});

	it("omits toolInputPreviewMaxLength when absent", () => {
		const result = normalizePermissionSystemConfig({});
		expect("toolInputPreviewMaxLength" in result).toBe(false);
	});

	it("includes toolTextSummaryMaxLength when a valid positive integer is provided", () => {
		const result = normalizePermissionSystemConfig({
			toolTextSummaryMaxLength: 120,
		});
		expect(result.toolTextSummaryMaxLength).toBe(120);
	});

	it("omits toolTextSummaryMaxLength when absent", () => {
		const result = normalizePermissionSystemConfig({});
		expect("toolTextSummaryMaxLength" in result).toBe(false);
	});
});
