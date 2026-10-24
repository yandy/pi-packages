import { aliyunSearch } from "./aliyun";
import { deepseekSearch } from "./deepseek";
import { exaSearch } from "./exa";
import type { SearchResponse } from "./types";

type SearchFn = (query: string, numResults: number, signal?: AbortSignal) => Promise<SearchResponse>;

interface ProviderEntry {
	name: string;
	fn: SearchFn;
}

export function buildProviders(apiKeys: Record<string, string | undefined>): ProviderEntry[] {
	return [
		{ name: "exa", fn: exaSearch },
		{
			name: "deepseek",
			fn: (query, numResults, signal) => deepseekSearch(query, numResults, signal, apiKeys.deepseek),
		},
		{
			name: "aliyun",
			fn: (query, numResults, signal) => aliyunSearch(query, numResults, signal, apiKeys.aliyun),
		},
	];
}

const DEFAULT_PROVIDERS = buildProviders({});

export async function search(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	onProgress?: (msg: string) => void,
	specifiedProvider?: string,
	providers?: ProviderEntry[],
): Promise<SearchResponse> {
	const errors: string[] = [];

	const src = providers ?? DEFAULT_PROVIDERS;

	const filtered = specifiedProvider ? src.filter((s) => s.name === specifiedProvider) : src;

	if (specifiedProvider && filtered.length === 0) {
		throw new Error(
			`Unknown provider: ${specifiedProvider}. Available: ${src.map((s) => s.name).join(", ")}`,
		);
	}

	for (const source of filtered) {
		try {
			onProgress?.(`Trying ${source.name}...`);
			const resp = await source.fn(query, numResults, signal);
			return resp;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${source.name}: ${msg}`);
		}
	}

	throw new Error(`All search providers failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}
