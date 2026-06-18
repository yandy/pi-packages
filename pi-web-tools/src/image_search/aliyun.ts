import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import OpenAI from "openai";
import { resolveSetting } from "../config";
import { createAliyunClient } from "../openai_client";
import { resolveAliyunProvider } from "../provider";
import type { ImageResult, ImageSearchParams, ImageSearchResponse } from "./types";

const DEFAULT_IMAGE_SEARCH_MODEL = "qwen3.7-plus";
const TIMEOUT_MS = 120_000;

export async function aliyunImageSearch(
	params: ImageSearchParams,
	signal?: AbortSignal,
	config?: { baseUrl?: string; aliyunProviderKey?: string; imageSearchModel?: string },
	ctx?: ExtensionContext,
): Promise<ImageSearchResponse> {
	const { query, imageUrl } = params;

	if (!query && !imageUrl) {
		throw new Error("At least one of query or imageUrl must be provided");
	}

	const { apiKey, baseUrl } = await resolveAliyunProvider({ ctx, config });
	const model = resolveSetting(
		process.env.ALIYUN_IMAGE_SEARCH_MODEL,
		config?.imageSearchModel,
		DEFAULT_IMAGE_SEARCH_MODEL,
	);
	const client = createAliyunClient({ apiKey, baseUrl });

	const s = signal
		? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
		: AbortSignal.timeout(TIMEOUT_MS);

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
		input = query;
	}

	const response = (await client.responses.create(
		{ model, input, tools } as unknown as OpenAI.Responses.ResponseCreateParams,
		{ signal: s },
	)) as unknown as AliyunImageResponse;

	const images = parseImages(response.output);
	const answer = parseAnswer(response.output);

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
