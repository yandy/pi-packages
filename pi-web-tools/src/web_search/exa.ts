import type { SearchResponse } from "./types";

const EXA_REST_URL = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://api.exa.ai/api/mcp";
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

	const answer =
		sources
			.map((s, i) => `${i + 1}. [${s.title}](${s.url})\n   ${s.snippet}`)
			.join("\n\n") || `No results found for: ${query}`;

	return { answer, sources, sourceLabel: "exa" };
}

async function exaMcpSearch(query: string, numResults: number, signal: AbortSignal): Promise<SearchResponse> {
	const initResp = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "initialize",
			params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-web-tools", version: "1.0" } },
			id: 1,
		}),
		signal,
	});

	if (!initResp.ok) {
		throw new Error(`Exa MCP initialize failed: ${initResp.status}`);
	}

	const searchResp = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "tools/call",
			params: {
				name: "web_search",
				arguments: { query, numResults, type: "auto", contents: { text: { maxCharacters: 3000 } } },
			},
			id: 2,
		}),
		signal,
	});

	if (!searchResp.ok) {
		throw new Error(`Exa MCP search failed: ${searchResp.status}`);
	}

	const data = (await searchResp.json()) as {
		result?: { content?: Array<{ text?: string }> };
	};

	const text = data.result?.content?.map((c) => c.text || "").join("\n\n") || "";

	const sources = parseMcpResults(text);

	const answer =
		sources
			.map((s, i) => `${i + 1}. [${s.title}](${s.url})\n   ${s.snippet}`)
			.join("\n\n") || `No results found for: ${query}`;

	return { answer, sources, sourceLabel: "exa" };
}

function parseMcpResults(text: string): Array<{ title: string; url: string; snippet: string }> {
	const results: Array<{ title: string; url: string; snippet: string }> = [];
	const lines = text.split("\n");
	let current: { title: string; url: string; snippet: string } | null = null;

	for (const line of lines) {
		const titleMatch = line.match(/^Title:\s*(.+)/);
		const urlMatch = line.match(/^URL:\s*(.+)/);
		const textMatch = line.match(/^Text:\s*(.+)/);

		if (titleMatch) {
			if (current) results.push(current);
			current = { title: titleMatch[1].trim(), url: "", snippet: "" };
		} else if (urlMatch && current) {
			current.url = urlMatch[1].trim();
		} else if (textMatch && current) {
			current.snippet = textMatch[1].trim().slice(0, 500);
		}
	}
	if (current?.url) results.push(current);
	return results;
}
