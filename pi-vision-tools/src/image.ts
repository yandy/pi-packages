import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export interface DecodedImage {
	data: Buffer;
	mimeType: string;
}

interface ImageReadOptions {
	readFile?: (path: string) => Promise<Buffer>;
}

const EXT_TO_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

const SUPPORTED_MIMES = new Set(Object.values(EXT_TO_MIME));

const DATA_URL_RE = /^data:([^;]+)?;base64,(.*)$/s;

function looksLikePath(s: string): boolean {
	if (s.startsWith("/")) return true;
	if (s.startsWith("./") || s.startsWith("../")) return true;
	if (s.startsWith("~")) return true;
	// has a dot-extension and is short enough not to be base64
	const ext = extname(s).toLowerCase();
	if (ext && EXT_TO_MIME[ext] && s.length <= 100) return true;
	return false;
}

export async function decodeImage(imagePath: string, opts?: ImageReadOptions): Promise<DecodedImage> {
	const src = imagePath?.trim();
	if (!src) throw new Error("image_path is required");

	// 1. data URL
	const m = DATA_URL_RE.exec(src);
	if (m) {
		const mime = (m[1] || "").toLowerCase();
		if (!SUPPORTED_MIMES.has(mime)) {
			throw new Error(`Unsupported image mime type: ${mime || "(missing)"}`);
		}
		const data = Buffer.from(m[2], "base64");
		if (data.length === 0) throw new Error("Empty image data in data URL");
		return { data, mimeType: mime };
	}

	// 2. file path
	if (looksLikePath(src)) {
		const ext = extname(src).toLowerCase();
		const mime = EXT_TO_MIME[ext];
		if (!mime) throw new Error(`Unsupported image extension: ${ext || "(none)"}`);
		const read = opts?.readFile ?? readFile;
		let data: Buffer;
		try {
			data = await read(src);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`Failed to read image file ${src}: ${msg}`);
		}
		if (data.length === 0) throw new Error(`Empty image file: ${src}`);
		return { data, mimeType: mime };
	}

	// 3. raw base64 (>100 chars)
	if (src.length > 100) {
		const data = Buffer.from(src, "base64");
		if (data.length === 0) throw new Error("Invalid base64 image data");
		return { data, mimeType: "image/png" };
	}

	throw new Error("image_path must be a file path, a data: URL, or raw base64 (>100 chars)");
}
