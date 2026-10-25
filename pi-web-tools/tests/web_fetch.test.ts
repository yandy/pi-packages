import { describe, expect, it, vi } from "vitest";
import {
	deepseekFetch,
	isTerminalFetchError,
	isThinContent,
	localFetch,
	UnsupportedContentTypeError,
	webFetch,
} from "../src/web_fetch.js";

function mockFetchResponse(overrides: Partial<Response> & { text: () => Promise<string> }) {
	return {
		ok: true,
		status: 200,
		url: "https://example.com",
		headers: new Headers(),
		...overrides,
	} as Response;
}

function mockBodyResponse(body: string, contentType: string, extraHeaders: Record<string, string> = {}) {
	return vi.fn().mockResolvedValueOnce(
		mockFetchResponse({
			headers: new Headers({ "content-type": contentType, ...extraHeaders }),
			text: () => Promise.resolve(body),
		}),
	);
}

function mockJsonResponse(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers(),
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body)),
	} as Response;
}

describe("webFetch", () => {
	it("fetches and returns content", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(
			mockFetchResponse({
				headers: new Headers({ "content-type": "text/html" }),
				text: () => Promise.resolve("<html><body><h1>Hello</h1><p>World</p></body></html>"),
			}),
		);

		const result = await webFetch("https://example.com", "markdown", 30, undefined, mockFetch);
		expect(result.content).toContain("# Hello");
		expect(result.content).toContain("World");
		expect(result.provider).toBe("local");
	});

	it("rejects invalid URLs", async () => {
		await expect(webFetch("not-a-url", "markdown", 30)).rejects.toThrow("Invalid URL: not-a-url");
	});
});

// ---------------------------------------------------------------------------
// localFetch 输出分支
// ---------------------------------------------------------------------------

describe("localFetch 输出分支", () => {
	it("returns the raw body untouched in origin format", async () => {
		const html = '<!doctype html><html><body><script>var x = 1;</script><main><h1>Raw</h1></main></body></html>';
		const result = await localFetch("https://example.com", "origin", 30, undefined, mockBodyResponse(html, "text/html"));

		expect(result.content).toBe(html);
		expect(result.title).toBeUndefined();
	});

	it("does not pretty-print JSON in origin format", async () => {
		const result = await localFetch(
			"https://api.example.com",
			"origin",
			30,
			undefined,
			mockBodyResponse('{"key":"value"}', "application/json"),
		);
		expect(result.content).toBe('{"key":"value"}');
	});

	it("pretty-prints JSON in markdown format", async () => {
		const result = await localFetch(
			"https://api.example.com",
			"markdown",
			30,
			undefined,
			mockBodyResponse('{"key":"value"}', "application/json"),
		);
		expect(result.content).toContain('"key": "value"');
	});

	it("returns plain text verbatim, preserving angle brackets", async () => {
		const source = "const xs: Array<string> = [];\n#include <vector>\nstd::vector<int> v;";
		const result = await localFetch("https://example.com/a.ts", "markdown", 30, undefined, mockBodyResponse(source, "text/plain"));

		expect(result.content).toBe(source);
	});

	it("treats HTML mislabeled as text/plain as HTML", async () => {
		const html = "<!doctype html><html><body><main><h1>Mislabeled</h1><p>Body.</p></main></body></html>";
		const result = await localFetch("https://example.com", "markdown", 30, undefined, mockBodyResponse(html, "text/plain"));

		expect(result.content).toContain("# Mislabeled");
	});

	it("rejects binary content types with a terminal error in markdown format", async () => {
		const fetchImpl = mockBodyResponse("\uFFFDPNG\u001a", "image/png", { "content-length": "612980" });

		const error = await localFetch("https://example.com/logo.png", "markdown", 30, undefined, fetchImpl).catch((e) => e);

		expect(error).toBeInstanceOf(UnsupportedContentTypeError);
		expect(error.message).toContain("Unsupported content type: image/png");
		expect(error.message).toContain("612980");
		expect(isTerminalFetchError(error)).toBe(true);
	});

	it("rejects binary content types in origin format too", async () => {
		await expect(
			localFetch("https://example.com/doc.pdf", "origin", 30, undefined, mockBodyResponse("%PDF-1.7", "application/pdf")),
		).rejects.toThrow("Unsupported content type: application/pdf");
	});

	it("keeps HTTP errors non-terminal", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			mockFetchResponse({ ok: false, status: 404, headers: new Headers({ "content-type": "text/html" }), text: () => Promise.resolve("Not Found") }),
		);

		const error = await localFetch("https://example.com", "markdown", 30, undefined, fetchImpl).catch((e) => e);

		expect(error.message).toContain("404");
		expect(isTerminalFetchError(error)).toBe(false);
	});

	it("truncates content over 100K characters", async () => {
		const result = await localFetch(
			"https://example.com",
			"markdown",
			30,
			undefined,
			mockBodyResponse("a".repeat(150_000), "text/plain"),
		);

		expect(result.content.length).toBeLessThan(150_000);
		expect(result.content).toContain("truncated");
	});
});

// ---------------------------------------------------------------------------
// deepseekFetch
// ---------------------------------------------------------------------------

describe("deepseekFetch", () => {
	it("calls Fetch API with Bearer auth and returns markdown result", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(mockJsonResponse(200, { title: "Page", content: "# Hi\n\nBody" }));

		const result = await deepseekFetch("https://example.com", "k", 30, undefined, mockFetch);

		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.deepseek.com/v1/tools/fetch",
			expect.objectContaining({
				method: "POST",
				headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
				body: JSON.stringify({ url: "https://example.com" }),
			}),
		);
		expect(result.provider).toBe("deepseek");
		expect(result.title).toBe("Page");
		expect(result.contentType).toBe("text/markdown");
		expect(result.status).toBe(200);
		expect(result.url).toBe("https://example.com");
		expect(result.content).toBe("# Hi\n\nBody");
	});

	it("throws when no API key", async () => {
		const mockFetch = vi.fn();

		await expect(deepseekFetch("https://example.com", "", 30, undefined, mockFetch)).rejects.toThrow(
			"DEEPSEEK_API_KEY not set",
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("throws with API error message on non-2xx", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(mockJsonResponse(403, { error: { message: "fetch blocked" } }));

		await expect(deepseekFetch("https://example.com", "k", 30, undefined, mockFetch)).rejects.toThrow(
			"DeepSeek API 403: fetch blocked",
		);
	});

	it("rejects URLs over 8192 characters before calling API", async () => {
		const mockFetch = vi.fn();
		const longUrl = `https://example.com/${"a".repeat(8200)}`;

		await expect(deepseekFetch(longUrl, "k", 30, undefined, mockFetch)).rejects.toThrow(
			"URL exceeds 8192 characters",
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("truncates content over 100K characters", async () => {
		const longContent = "a".repeat(100_001);
		const mockFetch = vi.fn().mockResolvedValueOnce(mockJsonResponse(200, { title: "Big", content: longContent }));

		const result = await deepseekFetch("https://example.com", "k", 30, undefined, mockFetch);

		expect(result.content).toContain("... [truncated 1 characters]");
	});
});

// ---------------------------------------------------------------------------
// isThinContent
// ---------------------------------------------------------------------------

describe("isThinContent", () => {
	it("detects empty shell pages", () => {
		expect(isThinContent("<div></div>", "text/html")).toBe(true);
	});

	it("detects js tag junk piles", () => {
		const junk = [
			"<script src=\"a.js\">",
			"<script src=\"b.js\">",
			"window.x = 1;",
			"{",
			"}",
			"document.write('x');",
			"",
			"Loading...",
		].join("\n");
		expect(isThinContent(junk, "text/html")).toBe(true);
	});

	it("exempts JSON responses", () => {
		expect(isThinContent("{}", "application/json")).toBe(false);
	});

	it("passes normal articles", () => {
		const article = [
			"# Title",
			"",
			"This is a normal article with plenty of meaningful natural-language text. ".repeat(5),
			"",
			"- list item one",
			"- list item two",
			"",
			"More paragraphs of real content follow here to push well past the threshold.".repeat(3),
		].join("\n");
		expect(isThinContent(article, "text/markdown")).toBe(false);
	});

	it("does not false-positive on parenthesis-led natural lines", () => {
		const article = [
			"# Research Notes",
			"",
			"(See figure 1.) The measurement setup was carefully calibrated before each run.",
			"",
			"Researchers repeated the experiment three times to confirm the observed effect. ".repeat(4),
			"",
			"Conclusion paragraphs with additional natural language content go here. ".repeat(3),
		].join("\n");
		expect(isThinContent(article, "text/markdown")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// webFetch provider 路由
// ---------------------------------------------------------------------------

describe("webFetch 路由", () => {
	const dsBody = JSON.stringify({ title: "DS Page", content: "# Rendered\n\nDeepSeek content." });

	function localOk(content = "Full article body. ".repeat(30), contentType = "text/html") {
		return vi.fn().mockResolvedValueOnce(
			mockFetchResponse({
				headers: new Headers({ "content-type": contentType }),
				text: () => Promise.resolve(`<html><body>${content}</body></html>`),
			}),
		);
	}

	it("returns local result without deepseek when local succeeds with real content", async () => {
		const globalFetch = vi.fn();
		vi.stubGlobal("fetch", globalFetch);
		try {
			const result = await webFetch("https://example.com", "markdown", 30, undefined, localOk(), {
				deepseekApiKey: "k",
			});
			expect(result.provider).toBe("local");
			expect(globalFetch).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("falls back to deepseek on local hard failure when key available", async () => {
		const localFail = vi.fn().mockRejectedValueOnce(new Error("HTTP 403 from https://example.com"));
		const globalFetch = vi.fn().mockResolvedValueOnce(mockJsonResponse(200, JSON.parse(dsBody)));
		vi.stubGlobal("fetch", globalFetch);
		try {
			const result = await webFetch("https://example.com", "markdown", 30, undefined, localFail, {
				deepseekApiKey: "k",
			});
			expect(result.provider).toBe("deepseek");
			expect(result.title).toBe("DS Page");
			expect(globalFetch).toHaveBeenCalledWith(
				"https://api.deepseek.com/v1/tools/fetch",
				expect.objectContaining({ method: "POST" }),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("propagates local error when no deepseek key", async () => {
		vi.stubEnv("DEEPSEEK_API_KEY", "");
		const localFail = vi.fn().mockRejectedValueOnce(new Error("HTTP 403 from https://example.com"));
		const globalFetch = vi.fn();
		vi.stubGlobal("fetch", globalFetch);
		try {
			await expect(
				webFetch("https://example.com", "markdown", 30, undefined, localFail, { deepseekApiKey: "" }),
			).rejects.toThrow("HTTP 403");
			expect(globalFetch).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	});

	it("aggregates errors when both providers fail", async () => {
		const localFail = vi.fn().mockRejectedValueOnce(new Error("HTTP 403 from https://example.com"));
		const globalFetch = vi.fn().mockResolvedValueOnce(mockJsonResponse(404, { error: { message: "no content" } }));
		vi.stubGlobal("fetch", globalFetch);
		try {
			await expect(
				webFetch("https://example.com", "markdown", 30, undefined, localFail, { deepseekApiKey: "k" }),
			).rejects.toThrow("All fetch providers failed");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("falls back to deepseek on thin content and returns deepseek result", async () => {
		const thinLocal = localOk("<div></div>");
		const globalFetch = vi.fn().mockResolvedValueOnce(mockJsonResponse(200, JSON.parse(dsBody)));
		vi.stubGlobal("fetch", globalFetch);
		try {
			const result = await webFetch("https://example.com", "markdown", 30, undefined, thinLocal, {
				deepseekApiKey: "k",
			});
			expect(result.provider).toBe("deepseek");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("returns local result when thin content and deepseek also fails", async () => {
		const thinLocal = localOk("<div></div>");
		const globalFetch = vi.fn().mockResolvedValueOnce(mockJsonResponse(404, { error: { message: "no content" } }));
		vi.stubGlobal("fetch", globalFetch);
		try {
			const result = await webFetch("https://example.com", "markdown", 30, undefined, thinLocal, {
				deepseekApiKey: "k",
			});
			expect(result.provider).toBe("local");
			// deepseek 确实被尝试且失败，而非从未尝试
			expect(globalFetch).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("never falls back for html format in chain mode", async () => {
		const localFail = vi.fn().mockRejectedValueOnce(new Error("HTTP 500 from https://example.com"));
		const globalFetch = vi.fn();
		vi.stubGlobal("fetch", globalFetch);
		try {
			await expect(
				webFetch("https://example.com", "html", 30, undefined, localFail, { deepseekApiKey: "k" }),
			).rejects.toThrow("HTTP 500");
			expect(globalFetch).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("auto-routes explicit deepseek with html format to local", async () => {
		const globalFetch = vi.fn();
		vi.stubGlobal("fetch", globalFetch);
		try {
			const result = await webFetch("https://example.com", "html", 30, undefined, localOk("<p>raw</p>"), {
				provider: "deepseek",
				deepseekApiKey: "k",
			});
			expect(result.provider).toBe("local");
			expect(globalFetch).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("throws when explicit deepseek requested without key", async () => {
		vi.stubEnv("DEEPSEEK_API_KEY", "");
		const globalFetch = vi.fn();
		vi.stubGlobal("fetch", globalFetch);
		try {
			await expect(
				webFetch("https://example.com", "markdown", 30, undefined, localOk(), {
					provider: "deepseek",
					deepseekApiKey: "",
				}),
			).rejects.toThrow("DEEPSEEK_API_KEY not set");
			expect(globalFetch).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	});

	it("does not fall back when provider explicitly local", async () => {
		const localFail = vi.fn().mockRejectedValueOnce(new Error("HTTP 500 from https://example.com"));
		const globalFetch = vi.fn();
		vi.stubGlobal("fetch", globalFetch);
		try {
			await expect(
				webFetch("https://example.com", "markdown", 30, undefined, localFail, {
					provider: "local",
					deepseekApiKey: "k",
				}),
			).rejects.toThrow("HTTP 500");
			expect(globalFetch).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("throws for unknown explicit provider", async () => {
		await expect(
			webFetch("https://example.com", "markdown", 30, undefined, localOk(), { provider: "bogus" }),
		).rejects.toThrow("Unknown provider: bogus. Available: local, deepseek");
	});
});
