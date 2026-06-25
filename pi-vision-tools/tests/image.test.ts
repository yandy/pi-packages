import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeImage } from "../src/image.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe("decodeImage — data URL", () => {
	it("decodes a base64 data URL", async () => {
		const b64 = PNG_MAGIC.toString("base64");
		const img = await decodeImage(`data:image/png;base64,${b64}`);
		expect(img.mimeType).toBe("image/png");
		expect(img.data).toEqual(PNG_MAGIC);
	});

	it("decodes a jpeg data URL", async () => {
		const b64 = JPEG_MAGIC.toString("base64");
		const img = await decodeImage(`data:image/jpeg;base64,${b64}`);
		expect(img.mimeType).toBe("image/jpeg");
		expect(img.data).toEqual(JPEG_MAGIC);
	});

	it("rejects a non-image data URL mime", async () => {
		await expect(decodeImage("data:text/plain;base64,aGVsbG8=")).rejects.toThrow(/mime|unsupported/i);
	});
});

describe("decodeImage — file path", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vision-img-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reads a png file and infers mime", async () => {
		const p = join(dir, "shot.png");
		await writeFile(p, PNG_MAGIC);
		const img = await decodeImage(p);
		expect(img.mimeType).toBe("image/png");
		expect(img.data).toEqual(PNG_MAGIC);
	});

	it("reads a jpeg file and infers mime", async () => {
		const p = join(dir, "photo.jpg");
		await writeFile(p, JPEG_MAGIC);
		const img = await decodeImage(p);
		expect(img.mimeType).toBe("image/jpeg");
	});

	it("rejects an unsupported extension", async () => {
		const p = join(dir, "x.txt");
		await writeFile(p, Buffer.from("nope"));
		await expect(decodeImage(p)).rejects.toThrow(/unsupported|mime/i);
	});

	it("rejects a missing file", async () => {
		await expect(decodeImage(join(dir, "nope.png"))).rejects.toThrow(/read|not found|no such/i);
	});
});

describe("decodeImage — raw base64", () => {
	it("decodes a long base64 string as image/png", async () => {
		const b64 = Buffer.concat([PNG_MAGIC, Buffer.alloc(200, 0)]).toString("base64");
		expect(b64.length).toBeGreaterThan(100);
		const img = await decodeImage(b64);
		expect(img.mimeType).toBe("image/png");
		expect(img.data.length).toBe(PNG_MAGIC.length + 200);
	});

	it("rejects a short string that is neither path nor data url", async () => {
		await expect(decodeImage("abc")).rejects.toThrow(/base64|path|unsupported/i);
	});
});
