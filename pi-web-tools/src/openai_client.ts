import OpenAI from "openai";

export function createAliyunClient(opts: { apiKey: string; baseUrl: string }): OpenAI {
	return new OpenAI({
		apiKey: opts.apiKey,
		baseURL: opts.baseUrl,
		maxRetries: 0,
	});
}
