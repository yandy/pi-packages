import { aliyunSearch } from "./aliyun";
import { exaSearch } from "./exa";
import type { SearchResponse } from "./types";

type SearchFn = (query: string, numResults: number, signal?: AbortSignal) => Promise<SearchResponse>;

interface SourceEntry {
	name: string;
	fn: SearchFn;
}

export function buildSources(
	apiKeys: Record<string, string | undefined>,
): SourceEntry[] {
	return [
		{ name: "exa", fn: exaSearch },
		{
			name: "aliyun",
			fn: (query, numResults, signal) =>
				aliyunSearch(query, numResults, signal, apiKeys.aliyun),
		},
	];
}

const DEFAULT_SOURCES = buildSources({});

export async function search(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	onProgress?: (msg: string) => void,
	specifiedSource?: string,
	sources?: SourceEntry[],
): Promise<SearchResponse> {
	const errors: string[] = [];

	const src = sources ?? DEFAULT_SOURCES;

	const filtered = specifiedSource
		? src.filter((s) => s.name === specifiedSource)
		: src;

	if (specifiedSource && filtered.length === 0) {
		throw new Error(
			`Unknown source: ${specifiedSource}. Available: ${src.map((s) => s.name).join(", ")}`,
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

	throw new Error(
		`All search sources failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
	);
}
