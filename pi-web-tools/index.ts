import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { webFetch } from "./src/web_fetch";
import { search, buildSources } from "./src/web_search/index";

export default function (pi: ExtensionAPI) {
	// -------------------------------------------------------------------
	// web_search
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			`Search the web via Exa (primary) or Aliyun (fallback) and return raw results (titles, URLs, snippets). With EXA_API_KEY: full REST API. Without: MCP free tier (150 calls/day). Set ALIYUN_API_KEY to enable Aliyun fallback. ` +
			`The current year is ${new Date().getFullYear()}.`,
		promptSnippet:
			"web_search: search the web via Exa (primary) or Aliyun (fallback). Returns raw results with titles, URLs, snippets. LLM synthesizes the answer.",
		promptGuidelines: [
			"Use web_search when you need current information outside your training data.",
			"Synthesize a clear answer from the search results and cite sources with markdown hyperlinks.",
		],
		parameters: Type.Object({
			query: Type.String({ minLength: 2, description: "The search query." }),
			numResults: Type.Optional(
				Type.Number({ minimum: 1, maximum: 20, default: 10, description: "Number of results (1-20)." }),
			),
			source: Type.Optional(Type.String({ enum: ["exa", "aliyun"], description: "Search source. Default: exa." })),
		}),
		renderCall(args, theme) {
			const p = args as { query: string };
			return new Text(
				theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", `"${p.query || "..."}"`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const text = result.content?.[0];
			const body = text?.type === "text" ? text.text : "";
			const lines = body.split("\n");
			if (!expanded) {
				const preview = lines.slice(0, 6);
				if (lines.length > 6) preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
				return new Text(preview.join("\n"), 0, 0);
			}
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const p = params as { query: string; numResults?: number; source?: string };
			const query = p.query?.trim();
			if (!query) {
				return { content: [{ type: "text", text: "Error: query is required." }], details: {}, isError: true };
			}

			onUpdate?.({ content: [{ type: "text", text: "Searching..." }], details: {} });

			let firstProgress = true;
			const onProgress = (msg: string) => {
				if (firstProgress) {
					onUpdate?.({ content: [{ type: "text", text: msg }], details: {} });
					firstProgress = false;
				}
			};

			try {
				const aliyunApiKey = await ctx.modelRegistry.getApiKeyForProvider("aliyun").catch(() => undefined);
				const sources = buildSources({ aliyun: aliyunApiKey });
				const result = await search(query, p.numResults ?? 10, signal, onProgress, p.source, sources);
				const sourceLabel = `\n\n*Source: ${result.sourceLabel}*`;
				return {
					content: [{ type: "text", text: result.answer + sourceLabel }],
					details: { source: result.sourceLabel, sources: result.sources },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Search failed: ${message}` }], details: {}, isError: true };
			}
		},
	});

	// -------------------------------------------------------------------
	// web_fetch
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: "Fetch content from a URL and return as text, markdown, or raw HTML.",
		promptSnippet: "web_fetch: fetch content from a URL as text, markdown, or raw HTML.",
		promptGuidelines: [
			"Use web_fetch to retrieve full page content from a URL.",
			"Prefer fetching specific pages rather than homepages for more targeted information.",
		],
		parameters: Type.Object({
			url: Type.String({ minLength: 5, description: "The URL to fetch content from." }),
			format: Type.Optional(
				Type.String({
					enum: ["text", "markdown", "html"],
					default: "markdown",
					description: "Output format. Default: markdown.",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 120,
					default: 30,
					description: "Timeout in seconds (1-120). Default: 30.",
				}),
			),
		}),
		renderCall(args, theme) {
			const p = args as { url: string };
			return new Text(theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", p.url || "..."), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const text = result.content?.[0];
			const body = text?.type === "text" ? text.text : "";
			const lines = body.split("\n");
			if (!expanded) {
				const preview = lines.slice(0, 6);
				if (lines.length > 6) preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
				return new Text(preview.join("\n"), 0, 0);
			}
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const p = params as { url: string; format?: "text" | "markdown" | "html"; timeout?: number };
			const url = p.url?.trim();
			if (!url) {
				return { content: [{ type: "text", text: "Error: url is required." }], details: {}, isError: true };
			}
			const format = p.format || "markdown";
			const timeout = p.timeout ?? 30;

			onUpdate?.({ content: [{ type: "text", text: `Fetching ${url}...` }], details: {} });

			try {
				const result = await webFetch(url, format, timeout, signal);
				const header = `URL: ${result.url}\nContent-Type: ${result.contentType}\n\n`;
				return {
					content: [{ type: "text", text: header + result.content }],
					details: { url: result.url, contentType: result.contentType, status: result.status },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Fetch failed: ${message}` }], details: {}, isError: true };
			}
		},
	});
}
