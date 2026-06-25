import { describe, expect, it } from "vitest";
import { compressImage, readCompressionSettings } from "../src/compress.js";
import type { DecodedImage } from "../src/image.js";

describe("readCompressionSettings", () => {
	it("uses defaults when env unset", () => {
		expect(readCompressionSettings({})).toEqual({ maxDim: 1568, jpegQuality: 85 });
	});

	it("reads custom values", () => {
		expect(readCompressionSettings({ PI_VISION_MAX_DIM: "800", PI_VISION_JPEG_QUALITY: "70" })).toEqual({
			maxDim: 800,
			jpegQuality: 70,
		});
	});

	it("clamps invalid values back to defaults", () => {
		expect(readCompressionSettings({ PI_VISION_MAX_DIM: "0", PI_VISION_JPEG_QUALITY: "999" })).toEqual({
			maxDim: 1568,
			jpegQuality: 85,
		});
	});

	it("clamps quality to [1,100]", () => {
		expect(readCompressionSettings({ PI_VISION_JPEG_QUALITY: "0" }).jpegQuality).toBe(85);
		expect(readCompressionSettings({ PI_VISION_JPEG_QUALITY: "50" }).jpegQuality).toBe(50);
	});
});

describe("compressImage", () => {
	const png: DecodedImage = { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" };

	it("returns the image unchanged when sharp loader resolves to null (sharp not installed)", async () => {
		const out = await compressImage(png, { maxDim: 1568, jpegQuality: 85 }, async () => null);
		expect(out).toBe(png);
	});

	it("returns the image unchanged when the loader throws", async () => {
		const out = await compressImage(png, { maxDim: 1568, jpegQuality: 85 }, async () => {
			throw new Error("Cannot find module 'sharp'");
		});
		expect(out).toBe(png);
	});

	it("uses a fake sharp pipeline to produce a jpeg DecodedImage", async () => {
		const pipeline = {
			resize: () => pipeline,
			removeAlpha: () => pipeline,
			jpeg: () => pipeline,
			toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
		};
		const fakeSharp = (_data: Buffer) => pipeline;
		const out = await compressImage(png, { maxDim: 100, jpegQuality: 80 }, async () => fakeSharp);
		expect(out.mimeType).toBe("image/jpeg");
		expect(out.data.length).toBeGreaterThan(0);
	});
});
