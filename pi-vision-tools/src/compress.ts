import type { DecodedImage } from "./image.js";

export interface CompressionSettings {
	maxDim: number;
	jpegQuality: number;
}

const DEFAULT_MAX_DIM = 1568;
const DEFAULT_JPEG_QUALITY = 85;

function parseIntOrDefault(v: string | undefined, dflt: number, min: number, max: number): number {
	if (v == null) return dflt;
	const n = Number.parseInt(v, 10);
	if (!Number.isFinite(n) || n < min || n > max) return dflt;
	return n;
}

export function readCompressionSettings(env: NodeJS.ProcessEnv = process.env): CompressionSettings {
	return {
		maxDim: parseIntOrDefault(env.PI_VISION_MAX_DIM, DEFAULT_MAX_DIM, 1, 10_000),
		jpegQuality: parseIntOrDefault(env.PI_VISION_JPEG_QUALITY, DEFAULT_JPEG_QUALITY, 1, 100),
	};
}

// Minimal structural type for the bits of sharp we use.
interface SharpPipeline {
	resize(opts: { width?: number; height?: number; withoutEnlargement: boolean; fit: string }): SharpPipeline;
	removeAlpha(): SharpPipeline;
	jpeg(opts: { quality: number }): SharpPipeline;
	toBuffer(): Promise<Buffer>;
}
type SharpModule = (data: Buffer) => SharpPipeline;

const defaultSharpLoader = async (): Promise<SharpModule | null> => {
	try {
		// @ts-ignore sharp is an optional dependency, may not be installed
		const mod = (await import("sharp")) as { default?: SharpModule } & SharpModule;
		return mod.default ?? (mod as unknown as SharpModule);
	} catch {
		return null;
	}
};

export async function compressImage(
	image: DecodedImage,
	settings: CompressionSettings,
	_sharpLoader: () => Promise<SharpModule | null> = defaultSharpLoader,
): Promise<DecodedImage> {
	let sharp: SharpModule | null;
	try {
		sharp = await _sharpLoader();
	} catch {
		return image;
	}
	if (!sharp) return image;

	try {
		const buf = await sharp(image.data)
			.resize({ width: settings.maxDim, height: settings.maxDim, withoutEnlargement: true, fit: "inside" })
			.removeAlpha()
			.jpeg({ quality: settings.jpegQuality })
			.toBuffer();
		return { data: buf, mimeType: "image/jpeg" };
	} catch {
		return image;
	}
}
