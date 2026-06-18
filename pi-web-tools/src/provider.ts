import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_PROVIDER_KEY = "aliyun";

interface ProviderConfig {
	baseUrl?: string;
	aliyunProviderKey?: string;
}

interface ResolvedProvider {
	apiKey: string;
	baseUrl: string;
}

export async function resolveAliyunProvider(opts: {
	ctx?: ExtensionContext;
	config?: ProviderConfig;
}): Promise<ResolvedProvider> {
	const { ctx, config } = opts;
	const providerKey = config?.aliyunProviderKey ?? DEFAULT_PROVIDER_KEY;

	// --- apiKey ---
	let apiKey: string | undefined;

	const envApiKey = process.env.ALIYUN_API_KEY;
	if (envApiKey) {
		apiKey = envApiKey;
	}

	if (!apiKey && providerKey && ctx) {
		const providerKeyResult = await ctx.modelRegistry.getApiKeyForProvider(providerKey);
		if (providerKeyResult) {
			apiKey = providerKeyResult;
		}
	}

	if (!apiKey) {
		throw new Error(
			"ALIYUN_API_KEY not configured. Set ALIYUN_API_KEY or configure aliyunProviderKey with a valid pi provider.",
		);
	}

	// --- baseUrl ---
	let baseUrl: string | undefined;

	const envBaseUrl = process.env.ALIYUN_BASE_URL;
	if (envBaseUrl) {
		baseUrl = envBaseUrl;
	}

	if (!baseUrl && providerKey && ctx) {
		const allModels = ctx.modelRegistry.getAll();
		const matchingModel = allModels.find((m) => m.provider === providerKey);
		if (matchingModel?.baseUrl) {
			baseUrl = matchingModel.baseUrl;
		}
	}

	if (!baseUrl && config?.baseUrl) {
		baseUrl = config.baseUrl;
	}

	if (!baseUrl) {
		baseUrl = DEFAULT_BASE_URL;
	}

	return { apiKey, baseUrl };
}
