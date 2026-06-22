import { createMcpClient } from "./mcp";
import type { SearchResponse } from "./types";

const EXA_REST_URL = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MCP_TOOL_NAME = "web_search_exa";
const TIMEOUT_MS = 60_000;

export async function exaSearch(query: string, numResults: number, signal?: AbortSignal): Promise<SearchResponse> {
	const apiKey = process.env.EXA_API_KEY;

	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	if (!apiKey) {
		return exaMcpSearch(query, numResults, s);
	}
	return exaRestSearch(query, numResults, apiKey, s);
}

async function exaRestSearch(
	query: string,
	numResults: number,
	apiKey: string,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const resp = await fetch(EXA_REST_URL, {
		method: "POST",
		headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({
			query,
			numResults,
			type: "auto",
			contents: { text: { maxCharacters: 3000 } },
		}),
		signal,
	});

	if (!resp.ok) {
		const detail = await resp.text().catch(() => resp.statusText);
		throw new Error(`Exa API ${resp.status}: ${detail}`);
	}

	const data = (await resp.json()) as {
		results?: Array<{ title?: string; url?: string; text?: string }>;
	};
	const results = data.results || [];

	const sources = results.map((r) => ({
		title: r.title || "Untitled",
		url: r.url || "",
		snippet: (r.text || "").slice(0, 500),
	}));

	const answer = formatAnswer(sources, query);
	return { answer, sources, sourceLabel: "exa" };
}

async function exaMcpSearch(query: string, numResults: number, signal: AbortSignal): Promise<SearchResponse> {
	const client = await createMcpClient(EXA_MCP_URL, {}, signal);

	try {
		const result = await client.callTool({
			name: MCP_TOOL_NAME,
			arguments: {
				query,
				numResults,
				type: "auto",
				contents: { text: { maxCharacters: 3000 } },
			},
		});

		const content = (result as { content?: Array<{ type: string; text: string }> })?.content ?? [];
		const text = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n\n");

		const sources = parseMcpResults(text);
		const answer = formatAnswer(sources, query);

		return { answer, sources, sourceLabel: "exa" };
	} finally {
		await client.close().catch(() => {});
	}
}

function formatAnswer(sources: Array<{ title: string; url: string; snippet: string }>, query: string): string {
	return (
		sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})\n   ${s.snippet}`).join("\n\n") ||
		`No results found for: ${query}`
	);
}

function parseMcpResults(text: string): Array<{ title: string; url: string; snippet: string }> {
	const results: Array<{ title: string; url: string; snippet: string }> = [];
	const blocks = text.split(/\n\n---\n\n/);

	for (const block of blocks) {
		const titleMatch = block.match(/^Title:\s*(.+)$/m);
		const urlMatch = block.match(/^URL:\s*(.+)$/m);
		const highlightsMatch = block.match(/^Highlights:\s*\n([\s\S]*?)$/m);

		if (urlMatch) {
			results.push({
				title: titleMatch?.[1]?.trim() || "Untitled",
				url: urlMatch[1].trim(),
				snippet: highlightsMatch?.[1]?.trim().slice(0, 500) || "",
			});
		}
	}

	return results;
}
