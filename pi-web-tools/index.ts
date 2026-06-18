import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "./src/config";
import { search } from "./src/web_search/index";
import { deepSearch } from "./src/deep_search/index";
import { imageSearch } from "./src/image_search/index";
import { webFetch } from "./src/web_fetch";

export default function (pi: ExtensionAPI) {
	// -------------------------------------------------------------------
	// web_search
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			`Search the web and return raw results (titles, URLs, snippets). Sources: Exa (REST/MCP) → DuckDuckGo (free, no key needed). ` +
			`Use "source" to pick a specific source. The current year is ${new Date().getFullYear()}.`,
		promptSnippet:
			"web_search: search the web via Exa → DuckDuckGo. Returns raw results with titles, URLs, snippets. LLM synthesizes the answer.",
		promptGuidelines: [
			"Use web_search when you need current information outside your training data.",
			"Synthesize a clear answer from the search results and cite sources with markdown hyperlinks.",
		],
		parameters: Type.Object({
			query: Type.String({ minLength: 2, description: "The search query." }),
			numResults: Type.Optional(
				Type.Number({ minimum: 1, maximum: 20, default: 10, description: "Number of results (1-20)." }),
			),
			source: Type.Optional(
				Type.String({ enum: ["exa", "duckduckgo"], description: "Specify source, or omit for auto-fallback." }),
			),
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
				if (lines.length > 6)
					preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
				return new Text(preview.join("\n"), 0, 0);
			}
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
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
				const result = await search(query, p.numResults ?? 10, signal, onProgress, p.source);
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
	// deep_search
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "deep_search",
		label: "Deep Search",
		description:
			"Deep search powered by Aliyun (Bailian) using web_search + web_extractor. The model searches the web, extracts page content, and synthesizes a comprehensive answer with sources.",
		promptSnippet:
			"deep_search: Aliyun-powered deep search that synthesizes web results into a comprehensive answer with sources.",
		promptGuidelines: [
			"Use deep_search for complex research questions that benefit from multi-source synthesis.",
			"deep_search is powered by Aliyun. Configure ALIYUN_API_KEY or use /login in pi.",
		],
		parameters: Type.Object({
			query: Type.String({ minLength: 2, description: "The search query." }),
		}),
		renderCall(args, theme) {
			const p = args as { query: string };
			return new Text(
				theme.fg("toolTitle", theme.bold("deep_search ")) + theme.fg("accent", `"${p.query || "..."}"`),
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
				if (lines.length > 6)
					preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
				return new Text(preview.join("\n"), 0, 0);
			}
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const p = params as { query: string };
			const query = p.query?.trim();
			if (!query) {
				return { content: [{ type: "text", text: "Error: query is required." }], details: {} };
			}

			onUpdate?.({ content: [{ type: "text", text: "Deep searching..." }], details: {} });

			try {
				const cfg = loadConfig(ctx.cwd);
				const result = await deepSearch(query, signal, cfg.aliyun);
				const sourcesText = result.sources.length
					? `\n\nSources:\n${result.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}`
					: "";
				return {
					content: [{ type: "text", text: result.answer + sourcesText }],
					details: { sources: result.sources },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Deep search failed: ${message}` }], details: {}, isError: true };
			}
		},
	});

	// -------------------------------------------------------------------
	// image_search
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "image_search",
		label: "Image Search",
		description:
			"Search for images by text description or find similar images by URL. Powered by Aliyun (Bailian). Returns image results and model analysis.",
		promptSnippet:
			"image_search: search images by text or find similar images by URL. Powered by Aliyun (Bailian).",
		promptGuidelines: [
			"Use image_search to find images matching a text description (provide query).",
			"Use image_search to find visually similar images (provide imageUrl, the image must be a publicly accessible URL).",
			"Both query and imageUrl can be provided together for combined search.",
		],
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ minLength: 2, description: "Text description of the image to search for." }),
			),
			imageUrl: Type.Optional(
				Type.String({ description: "Public URL of the image to find similar images." }),
			),
		}),
		renderCall(args, theme) {
			const p = args as { query?: string; imageUrl?: string };
			const label = theme.fg("toolTitle", theme.bold("image_search "));
			if (p.imageUrl) return new Text(label + theme.fg("accent", `[image: ${p.imageUrl}]`), 0, 0);
			return new Text(label + theme.fg("accent", `"${p.query || "..."}"`), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const text = result.content?.[0];
			const body = text?.type === "text" ? text.text : "";
			const lines = body.split("\n");
			if (!expanded) {
				const preview = lines.slice(0, 6);
				if (lines.length > 6)
					preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
				return new Text(preview.join("\n"), 0, 0);
			}
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			const p = params as { query?: string; imageUrl?: string };
			if (!p.query && !p.imageUrl) {
				return {
					content: [{ type: "text", text: "Error: at least one of query or imageUrl is required." }],
					details: {},
					isError: true,
				};
			}

			onUpdate?.({ content: [{ type: "text", text: "Searching images..." }], details: {} });

			try {
				const cfg = loadConfig(ctx.cwd);
				const result = await imageSearch({ query: p.query, imageUrl: p.imageUrl }, signal, ctx, cfg.aliyun);
				const imagesText = result.images.length
					? "\n\nImages:\n" +
						result.images.map((img) => `${img.index}. [${img.title}](${img.url})`).join("\n")
					: "";
				return {
					content: [{ type: "text", text: result.answer + imagesText }],
					details: { images: result.images },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Image search failed: ${message}` }],
					details: {},
					isError: true,
				};
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
				if (lines.length > 6)
					preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
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
