import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type OpenAI from "openai";
import { resolveSetting } from "../config";
import { createAliyunClient } from "../openai_client";
import { resolveAliyunProvider } from "../provider";
import type { DeepSearchOptions, DeepSearchResponse } from "./types";

const DEFAULT_DEEP_SEARCH_MODEL = "deepseek-v4-flash";
const TIMEOUT_MS = 120_000;

export async function aliyunDeepSearch(
	query: string,
	signal?: AbortSignal,
	config?: { baseUrl?: string; aliyunProviderKey?: string; deepSearchModel?: string },
	ctx?: ExtensionContext,
	searchOpts?: DeepSearchOptions,
): Promise<DeepSearchResponse> {
	const { apiKey, baseUrl } = await resolveAliyunProvider({ ctx, config });
	const model = resolveSetting(process.env.ALIYUN_DEEP_SEARCH_MODEL, config?.deepSearchModel, DEFAULT_DEEP_SEARCH_MODEL);
	const client = createAliyunClient({ apiKey, baseUrl });

	const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

	const { enableSearchExtension, freshness, assignedSiteList, enableImageOutput } = searchOpts ?? {};

	const searchOptions: Record<string, unknown> = {
		search_strategy: "turbo",
		forced_search: true,
		...(enableSearchExtension && { enable_search_extension: true }),
		...(freshness && { freshness }),
		...(assignedSiteList?.length && { assigned_site_list: assignedSiteList }),
	};

	const completion = await client.chat.completions.create(
		{
			model,
			messages: [{ role: "user", content: query }],
			stream: false,
			enable_search: true,
			search_options: searchOptions,
			...(enableImageOutput && { enable_text_image_mixed: true }),
		} as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
		{ signal: s },
	);

	const answer = completion.choices[0]?.message?.content || "No results";
	return { answer, sources: [] };
}
