import type { SearchResponse } from "./types";
import { exaSearch } from "./exa";

type SearchFn = (query: string, numResults: number, signal?: AbortSignal) => Promise<SearchResponse>;

interface SourceEntry {
	name: string;
	fn: SearchFn;
}

const SOURCES: SourceEntry[] = [
	{
		name: "exa",
		fn: exaSearch,
	},
];

export async function search(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	onProgress?: (msg: string) => void,
	specifiedSource?: string,
): Promise<SearchResponse> {
	const errors: string[] = [];

	const sources = specifiedSource ? SOURCES.filter((s) => s.name === specifiedSource) : SOURCES;

	if (specifiedSource && sources.length === 0) {
		throw new Error(`Unknown source: ${specifiedSource}. Available: ${SOURCES.map((s) => s.name).join(", ")}`);
	}

	for (const source of sources) {
		try {
			onProgress?.(`Trying ${source.name}...`);
			const resp = await source.fn(query, numResults, signal);
			return resp;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${source.name}: ${msg}`);
		}
	}

	throw new Error(`All search sources failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}
