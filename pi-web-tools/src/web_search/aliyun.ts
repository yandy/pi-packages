import { createMcpClient } from "./mcp";
import type { SearchResponse, SearchSource } from "./types";

const ALIYUN_MCP_URL = "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp";
const MCP_TOOL_NAME = "bailian_web_search";
const TIMEOUT_MS = 60_000;

export async function aliyunSearch(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	apiKey?: string,
): Promise<SearchResponse> {
	const key = apiKey || process.env.ALIYUN_API_KEY;
	if (!key) {
		throw new Error("ALIYUN_API_KEY not set. Get one at https://bailian.console.aliyun.com");
	}

	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	const headers: Record<string, string> = {
		Authorization: `Bearer ${key}`,
	};

	const client = await createMcpClient(ALIYUN_MCP_URL, headers, s);

	try {
		const result = await client.callTool({
			name: MCP_TOOL_NAME,
			arguments: { query, count: numResults },
		});

		const content = (result as { content?: Array<{ type: string; text: string }> })?.content ?? [];
		const text = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n\n");

		const sources = parseBailianResults(text);
		const answer = formatAnswer(sources, query);

		return { answer, sources, sourceLabel: "aliyun" };
	} finally {
		await client.close().catch(() => {});
	}
}

function parseBailianResults(text: string): SearchSource[] {
	try {
		const data = JSON.parse(text) as {
			pages?: Array<{
				title?: string;
				link?: string;
				url?: string;
				snippet?: string;
				content?: string;
			}>;
		};
		return (data.pages || []).map((p) => ({
			title: p.title || "Untitled",
			url: p.link || p.url || "",
			snippet: (p.snippet || p.content || "").slice(0, 500),
		}));
	} catch {
		return parseTextResults(text);
	}
}

function parseTextResults(text: string): SearchSource[] {
	const results: SearchSource[] = [];
	const blocks = text.split(/\n\n---\n\n/);

	for (const block of blocks) {
		const titleMatch = block.match(/^Title:\s*(.+)$/m);
		const urlMatch = block.match(/^(?:URL|Link):\s*(.+)$/m);
		const snippetMatch = block.match(/^(?:Highlights|Snippet|Content):\s*\n([\s\S]*?)$/m);

		if (urlMatch) {
			results.push({
				title: titleMatch?.[1]?.trim() || "Untitled",
				url: urlMatch[1].trim(),
				snippet: snippetMatch?.[1]?.trim().slice(0, 500) || "",
			});
		}
	}

	return results;
}

function formatAnswer(sources: SearchSource[], query: string): string {
	const lines = sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})\n   ${s.snippet}`);
	return lines.join("\n\n") || `No results found for: ${query}`;
}
