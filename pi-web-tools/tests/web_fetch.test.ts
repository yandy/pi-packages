import { describe, expect, it, vi } from "vitest";
import { deepseekFetch, webFetch } from "../src/web_fetch.js";

function mockFetchResponse(overrides: Partial<Response> & { text: () => Promise<string> }) {
	return {
		ok: true,
		status: 200,
		url: "https://example.com",
		headers: new Headers(),
		...overrides,
	} as Response;
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

	it("converts HTML to plain text", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(
			mockFetchResponse({
				headers: new Headers({ "content-type": "text/html" }),
				text: () => Promise.resolve("<html><body><p>Hello World</p></body></html>"),
			}),
		);

		const result = await webFetch("https://example.com", "text", 30, undefined, mockFetch);
		expect(result.content.trim()).toBe("Hello World");
	});

	it("returns raw HTML in html format", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(
			mockFetchResponse({
				headers: new Headers({ "content-type": "text/html" }),
				text: () => Promise.resolve("<html>raw</html>"),
			}),
		);

		const result = await webFetch("https://example.com", "html", 30, undefined, mockFetch);
		expect(result.content).toContain("<html>");
	});

	it("formats JSON responses", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(
			mockFetchResponse({
				headers: new Headers({ "content-type": "application/json" }),
				text: () => Promise.resolve('{"key":"value"}'),
			}),
		);

		const result = await webFetch("https://api.example.com", "text", 30, undefined, mockFetch);
		// JSON is pretty-printed with a 2-space indent — the raw body has no space after the colon.
		expect(result.content).toContain('"key": "value"');
	});

	it("throws on non-2xx", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(
			mockFetchResponse({
				ok: false,
				status: 404,
				headers: new Headers({ "content-type": "text/html" }),
				text: () => Promise.resolve("Not Found"),
			}),
		);

		await expect(webFetch("https://example.com", "text", 30, undefined, mockFetch)).rejects.toThrow("404");
	});

	it("rejects invalid URLs", async () => {
		await expect(webFetch("not-a-url", "text", 30)).rejects.toThrow("Invalid URL");
	});

	it("truncates content over 100K characters", async () => {
		const longText = "a".repeat(150_000);
		const mockFetch = vi.fn().mockResolvedValueOnce(
			mockFetchResponse({
				headers: new Headers({ "content-type": "text/plain" }),
				text: () => Promise.resolve(longText),
			}),
		);

		const result = await webFetch("https://example.com", "text", 30, undefined, mockFetch);
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
