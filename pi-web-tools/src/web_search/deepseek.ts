import type { SearchResponse } from "./types";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const TIMEOUT_MS = 60_000;

export async function deepseekSearch(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	apiKey?: string,
): Promise<SearchResponse> {
	const key = apiKey || process.env.DEEPSEEK_API_KEY;
	if (!key) {
		throw new Error("DEEPSEEK_API_KEY not set. Get one at https://platform.deepseek.com");
	}

	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	const resp = await fetch(DEEPSEEK_SEARCH_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, count: numResults }),
		signal: s,
	});

	if (!resp.ok) {
		const detail = await resp
			.json()
			.then((data) => {
				const message = (data as { error?: { message?: string } })?.error?.message;
				return message || resp.statusText;
			})
			.catch(() => resp.statusText);
		throw new Error(`DeepSeek API ${resp.status}: ${detail}`);
	}

	const data = (await resp.json()) as {
		results?: Array<{ title?: string; url?: string; snippet?: string; summary?: string }>;
	};
	const results = data.results || [];

	const sources = results.map((r) => ({
		title: r.title || "Untitled",
		url: r.url || "",
		snippet: r.summary || r.snippet || "",
	}));

	const answer = formatAnswer(sources, query);
	return { answer, sources, providerLabel: "deepseek" };
}

function formatAnswer(sources: Array<{ title: string; url: string; snippet: string }>, query: string): string {
	return (
		sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})\n   ${s.snippet}`).join("\n\n") ||
		`No results found for: ${query}`
	);
}
