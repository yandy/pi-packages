import type { SearchSource, SearchResponse } from "./types";

const DDG_URL = "https://api.duckduckgo.com/";
const TIMEOUT_MS = 30_000;

interface DdgTopic {
	Text?: string;
	FirstURL?: string;
	Topics?: DdgTopic[];
}

interface DdgResponse {
	Abstract?: string;
	AbstractText?: string;
	AbstractURL?: string;
	RelatedTopics?: DdgTopic[];
}

export async function duckduckgoSearch(
	query: string,
	numResults: number,
	signal?: AbortSignal,
): Promise<SearchResponse> {
	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	const url = `${DDG_URL}?q=${encodeURIComponent(query)}&format=json&no_html=1`;
	const resp = await fetch(url, { signal: s });

	if (!resp.ok) {
		throw new Error(`DuckDuckGo API ${resp.status}: ${resp.statusText}`);
	}

	const data = (await resp.json()) as DdgResponse;
	const sources: SearchSource[] = [];

	if (data.Abstract && data.AbstractURL) {
		sources.push({
			title: data.Abstract,
			url: data.AbstractURL,
			snippet: data.AbstractText || "",
		});
	}

	function processTopic(topic: DdgTopic): void {
		if (sources.length >= numResults) return;
		if (topic.FirstURL && topic.Text) {
			const parts = topic.Text.split(" - ");
			sources.push({
				title: parts[0] || topic.Text,
				url: topic.FirstURL,
				snippet: parts.slice(1).join(" - ") || topic.Text,
			});
		}
		for (const sub of topic.Topics || []) {
			processTopic(sub);
		}
	}

	for (const topic of data.RelatedTopics || []) {
		processTopic(topic);
	}

	const answer =
		sources
			.map((s, i) => `${i + 1}. [${s.title}](${s.url})\n   ${s.snippet}`)
			.join("\n\n") || `No results found for: ${query}`;

	return { answer, sources, sourceLabel: "duckduckgo" };
}
