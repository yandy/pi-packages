import { describe, expect, it, vi } from "vitest";
import { webFetch } from "../src/web_fetch.js";

function mockFetchResponse(overrides: Partial<Response> & { text: () => Promise<string> }) {
	return {
		ok: true,
		status: 200,
		url: "https://example.com",
		headers: new Headers(),
		...overrides,
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
		expect(result.content).toContain('"key"');
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
