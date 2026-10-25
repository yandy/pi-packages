import {
	isBinaryContentType,
	isHtmlContentType,
	isJsonContentType,
	looksLikeHtml,
	mediaType,
} from "./content_type.js";
import { htmlToMarkdown } from "./html_to_markdown.js";

const MAX_CONTENT_CHARS = 100_000;
const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
const DEEPSEEK_MAX_URL = 8192;

/** 输出格式：markdown 做最小必要变换，origin 原样返回 */
export type FetchFormat = "markdown" | "origin";

/** 内容类型无法产出文本时的终态错误：链式模式不应再回落其它 provider */
export class UnsupportedContentTypeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedContentTypeError";
	}
}

export function isTerminalFetchError(error: unknown): boolean {
	return error instanceof UnsupportedContentTypeError;
}

export interface FetchResult {
	content: string;
	contentType: string;
	url: string;
	status: number;
	provider: "local" | "deepseek";
	title?: string;
}

function applyTruncation(content: string): string {
	if (content.length > MAX_CONTENT_CHARS) {
		const truncated = content.slice(0, MAX_CONTENT_CHARS);
		return `${truncated}\n\n... [truncated ${content.length - MAX_CONTENT_CHARS} characters]`;
	}
	return content;
}

export interface WebFetchOptions {
	provider?: string;
	deepseekApiKey?: string;
	onProgress?: (msg: string) => void;
}

export async function webFetch(
	url: string,
	format: FetchFormat,
	timeout: number,
	signal?: AbortSignal,
	_fetch?: typeof fetch,
	opts?: WebFetchOptions,
): Promise<FetchResult> {
	// 入口校验与 provider 无关，保持不变
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new Error(`Invalid URL: ${url}`);
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`);
	}

	if (format !== "markdown" && format !== "origin") {
		throw new Error(`Unknown format: ${format}. Available: markdown, origin`);
	}

	const apiKey = opts?.deepseekApiKey || process.env.DEEPSEEK_API_KEY;

	if (opts?.provider === "deepseek") {
		// deepseek 服务端只返回 Markdown，origin 无法产出：自动走 local 并如实标注
		if (format === "origin") return localFetch(url, format, timeout, signal, _fetch);
		return deepseekFetch(url, apiKey ?? "", timeout, signal);
	}
	if (opts?.provider === "local") {
		return localFetch(url, format, timeout, signal, _fetch);
	}
	if (opts?.provider !== undefined) {
		throw new Error(`Unknown provider: ${opts.provider}. Available: local, deepseek`);
	}

	// 链式：local → deepseek
	const canFallback = format !== "origin" && Boolean(apiKey);
	try {
		const local = await localFetch(url, format, timeout, signal, _fetch);
		if (canFallback && isThinContent(local.content, local.contentType)) {
			opts?.onProgress?.("Local fetch returned thin content, trying deepseek...");
			try {
				return await deepseekFetch(url, apiKey ?? "", timeout, signal);
			} catch {
				// 聊胜于无：返回 local 原结果
				return local;
			}
		}
		return local;
	} catch (localErr) {
		// terminal 错误（如二进制内容）：换 provider 也拿不到文本，直接抛原错误
		if (canFallback && !isTerminalFetchError(localErr)) {
			try {
				return await deepseekFetch(url, apiKey ?? "", timeout, signal);
			} catch (dsErr) {
				const localMsg = localErr instanceof Error ? localErr.message : String(localErr);
				const dsMsg = dsErr instanceof Error ? dsErr.message : String(dsErr);
				throw new Error(`All fetch providers failed:\n  - local: ${localMsg}\n  - deepseek: ${dsMsg}`);
			}
		}
		throw localErr;
	}
}

export async function localFetch(
	url: string,
	format: FetchFormat,
	timeout: number,
	signal?: AbortSignal,
	_fetch?: typeof fetch,
): Promise<FetchResult> {
	const doFetch = _fetch ?? fetch;
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new Error(`Invalid URL: ${url}`);
	}

	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`);
	}

	const timeoutMs = Math.min(timeout * 1000, 120_000);
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	const response = await doFetch(url, {
		method: "GET",
		headers: {
			"User-Agent": "pi-web-tools/1.0",
			Accept: format === "origin" ? "*/*" : "text/html, text/plain, application/json",
		},
		redirect: "follow",
		signal: s,
	});

	const contentType = response.headers.get("content-type") || "text/plain";

	if (!response.ok) {
		const truncated = (await response.text()).slice(0, 500);
		throw new Error(`HTTP ${response.status} from ${url}${truncated ? `: ${truncated}` : ""}`);
	}

	if (isBinaryContentType(contentType)) {
		const length = response.headers.get("content-length");
		throw new UnsupportedContentTypeError(
			`Unsupported content type: ${mediaType(contentType)}${length ? `, ${length} bytes` : ""}. webfetch only returns text; download the file with another tool.`,
		);
	}

	const body = await response.text();
	const base = { contentType, url: response.url, status: response.status, provider: "local" as const };

	if (format === "origin") {
		return { ...base, content: applyTruncation(body) };
	}

	if (isHtmlContentType(contentType) || looksLikeHtml(body)) {
		const { content, title } = htmlToMarkdown(body);
		return { ...base, content: applyTruncation(content), title };
	}

	if (isJsonContentType(contentType)) {
		try {
			return { ...base, content: applyTruncation(JSON.stringify(JSON.parse(body), null, 2)) };
		} catch {
			return { ...base, content: applyTruncation(body) };
		}
	}

	return { ...base, content: applyTruncation(body) };
}

export async function deepseekFetch(
	url: string,
	apiKey: string,
	timeout: number,
	signal?: AbortSignal,
	_fetch?: typeof fetch,
): Promise<FetchResult> {
	const key = apiKey || process.env.DEEPSEEK_API_KEY;
	if (!key) {
		throw new Error("DEEPSEEK_API_KEY not set. Get one at https://platform.deepseek.com");
	}
	if (url.length > DEEPSEEK_MAX_URL) {
		throw new Error(`URL exceeds ${DEEPSEEK_MAX_URL} characters`);
	}

	const doFetch = _fetch ?? fetch;
	const timeoutMs = Math.min(timeout * 1000, 120_000);
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	const resp = await doFetch(DEEPSEEK_FETCH_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({ url }),
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

	const data = (await resp.json()) as { title?: string; content?: string };

	return {
		content: applyTruncation(data.content || ""),
		contentType: "text/markdown",
		url,
		status: 200,
		provider: "deepseek",
		title: data.title || undefined,
	};
}

const THIN_MIN_CHARS = 200;

export function isThinContent(content: string, contentType: string): boolean {
	if (contentType.includes("json")) return false;
	const meaningful = content
		.split("\n")
		.filter((line) => !isJunkLine(line))
		.join("\n");
	return meaningful.trim().length < THIN_MIN_CHARS;
}

function isJunkLine(line: string): boolean {
	const t = line.trim();
	if (!t) return true;
	if (/^<\/?[a-z][^>]*>$/i.test(t)) return true;
	if (/^(?:var|let|const|function|return|import|export|window\.|document\.|self\.|@media|@import)\b/.test(t)) return true;
	if (/^[{}()[\];,]/.test(t)) return true;
	if (/^(?:\/\/|\/\*|\*\/|<!--)/.test(t)) return true;
	if (t.length > 500) {
		const spaces = t.match(/\s/g)?.length ?? 0;
		if (spaces / t.length < 0.05) return true;
	}
	return false;
}
