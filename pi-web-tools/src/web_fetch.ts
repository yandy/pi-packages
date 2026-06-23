import TurndownService from "turndown";

const MAX_CONTENT_CHARS = 100_000;
const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

export interface FetchResult {
	content: string;
	contentType: string;
	url: string;
	status: number;
}

export async function webFetch(
	url: string,
	format: "text" | "markdown" | "html",
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
			Accept: format === "html" ? "text/html" : "text/html, text/plain, application/json",
		},
		redirect: "follow",
		signal: s,
	});

	const contentType = response.headers.get("content-type") || "text/plain";
	const body = await response.text();

	if (!response.ok) {
		const truncated = body.slice(0, 500);
		throw new Error(`HTTP ${response.status} from ${url}${truncated ? `: ${truncated}` : ""}`);
	}

	let content: string;

	if (contentType.includes("application/json")) {
		try {
			content = JSON.stringify(JSON.parse(body), null, 2);
		} catch {
			content = body;
		}
	} else if (format === "html") {
		content = body;
	} else if (format === "markdown") {
		content = turndown.turndown(body);
	} else {
		content = stripTags(body);
	}

	if (content.length > MAX_CONTENT_CHARS) {
		const truncated = content.slice(0, MAX_CONTENT_CHARS);
		content = `${truncated}\n\n... [truncated ${content.length - MAX_CONTENT_CHARS} characters]`;
	}

	return { content, contentType, url: response.url, status: response.status };
}

function stripTags(html: string): string {
	let text = html;
	text = text.replace(/<head[\s\S]*?<\/head>/gi, "");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
	text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<[^>]+>/g, "");
	text = text.replace(/&amp;/g, "&");
	text = text.replace(/&lt;/g, "<");
	text = text.replace(/&gt;/g, ">");
	text = text.replace(/&quot;/g, '"');
	text = text.replace(/&#39;/g, "'");
	text = text.replace(/&nbsp;/g, " ");
	text = text.replace(/\n{3,}/g, "\n\n");
	text = text.replace(/[ \t]+/g, " ");
	return text.trim();
}
