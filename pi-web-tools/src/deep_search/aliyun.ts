import type { DeepSearchResponse } from "./types";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSetting } from "../config";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.7-plus";
const TIMEOUT_MS = 120_000;

export async function aliyunDeepSearch(
	query: string,
	signal?: AbortSignal,
	config?: { baseUrl?: string; searchModel?: string },
	ctx?: ExtensionContext,
): Promise<DeepSearchResponse> {
	const apiKey = await resolveApiKey(ctx);
	const baseUrl = resolveSetting(process.env.ALIYUN_BASE_URL, config?.baseUrl, DEFAULT_BASE_URL);
	const model = resolveSetting(process.env.ALIYUN_SEARCH_MODEL, config?.searchModel, DEFAULT_MODEL);

	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	const resp = await fetch(`${baseUrl}/responses`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			input: query,
			tools: [{ type: "web_search" }, { type: "web_extractor" }],
		}),
		signal: s,
	});

	if (!resp.ok) {
		const detail = await resp.text().catch(() => resp.statusText);
		throw new Error(`Aliyun API ${resp.status}: ${detail}`);
	}

	const data = (await resp.json()) as AliyunResponse;

	const sources = parseSources(data.output);
	const answer = parseAnswer(data.output);

	return { answer, sources };
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

interface AliyunResponse {
	output?: Array<AliyunOutputItem>;
}

type AliyunOutputItem =
	| { type: "web_search_call"; action?: { query?: string }; sources?: Array<{ type?: string; url?: string }> }
	| { type: "web_extractor_call"; urls?: string[]; output?: string }
	| { type: "message"; content?: Array<{ type?: string; text?: string }> }
	| { type: string; [key: string]: unknown };

function parseSources(
	output: AliyunOutputItem[] = [],
): Array<{ title: string; url: string }> {
	const searchCalls = output.filter(
		(item) => item.type === "web_search_call",
	) as Array<{
		type: "web_search_call";
		sources?: Array<{ type?: string; url?: string }>;
	}>;
	const sources: Array<{ title: string; url: string }> = [];

	for (const call of searchCalls) {
		for (const src of call.sources || []) {
			if (src.url) {
				const domain = extractDomain(src.url);
				sources.push({ title: domain, url: src.url });
			}
		}
	}
	return sources;
}

function parseAnswer(output: AliyunOutputItem[] = []): string {
	const messages = output.filter((item) => item.type === "message") as Array<{
		type: "message";
		content?: Array<{ type?: string; text?: string }>;
	}>;
	const texts = messages.flatMap((m) =>
		(m.content || []).filter((c) => c.type === "output_text").map((c) => c.text || ""),
	);
	return texts.join("\n") || "No results";
}

function extractDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}
