import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageResult, ImageSearchParams, ImageSearchResponse } from "./types";
import { resolveSetting } from "../config";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.7-plus";
const TIMEOUT_MS = 120_000;

export async function aliyunImageSearch(
	params: ImageSearchParams,
	signal?: AbortSignal,
	ctx?: ExtensionContext,
	config?: { baseUrl?: string; searchModel?: string },
): Promise<ImageSearchResponse> {
	const { query, imageUrl } = params;

	if (!query && !imageUrl) {
		throw new Error("At least one of query or imageUrl must be provided");
	}

	const textQuery = query;

	const apiKey = await resolveApiKey(ctx);
	const baseUrl = resolveSetting(process.env.ALIYUN_BASE_URL, config?.baseUrl, DEFAULT_BASE_URL);
	const model = resolveSetting(process.env.ALIYUN_SEARCH_MODEL, config?.searchModel, DEFAULT_MODEL);

	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let input: unknown;
	let tools: Array<{ type: string }>;

	if (imageUrl) {
		tools = [{ type: "image_search" }];
		const content: Array<{ type: string; [key: string]: unknown }> = [];
		if (query) {
			content.push({ type: "input_text", text: query });
		}
		content.push({ type: "input_image", image_url: imageUrl });
		input = [{ role: "user", content }];
	} else {
		tools = [{ type: "web_search_image" }];
		input = textQuery;
	}

	const resp = await fetch(`${baseUrl}/responses`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model, input, tools }),
		signal: s,
	});

	if (!resp.ok) {
		const detail = await resp.text().catch(() => resp.statusText);
		throw new Error(`Aliyun API ${resp.status}: ${detail}`);
	}

	const data = (await resp.json()) as AliyunImageResponse;

	const images = parseImages(data.output);
	const answer = parseAnswer(data.output);

	return { answer, images };
}

interface AliyunImageResponse {
	output?: Array<{
		type: string;
		output?: string;
		content?: Array<{ type?: string; text?: string }>;
	}>;
}

function parseImages(output: AliyunImageResponse["output"] = []): ImageResult[] {
	for (const item of output) {
		if (item.type === "web_search_image_call" || item.type === "image_search_call") {
			try {
				return JSON.parse(item.output || "[]") as ImageResult[];
			} catch {
				return [];
			}
		}
	}
	return [];
}

function parseAnswer(output: AliyunImageResponse["output"] = []): string {
	const messages = output.filter((item) => item.type === "message");
	const texts = messages.flatMap((m) =>
		(m.content || []).filter((c) => c.type === "output_text").map((c) => c.text || ""),
	);
	return texts.join("\n") || "No results";
}

async function resolveApiKey(ctx?: ExtensionContext): Promise<string> {
	if (ctx) {
		const key = await ctx.modelRegistry.getApiKeyForProvider("aliyun");
		if (key) return key;
	}
	const env = process.env.ALIYUN_API_KEY;
	if (env) return env;
	throw new Error("ALIYUN_API_KEY not configured. Set ALIYUN_API_KEY or use /login in pi.");
}
