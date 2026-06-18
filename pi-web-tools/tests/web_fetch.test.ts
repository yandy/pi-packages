import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let webFetch: typeof import("../src/web_fetch.js").webFetch;

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	const mod = await import("../src/web_fetch.js");
	webFetch = mod.webFetch;
});

describe("webFetch", () => {
	it("fetches and returns content", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			url: "https://example.com",
			headers: new Headers({ "content-type": "text/html" }),
			text: () => Promise.resolve("<html><body><h1>Hello</h1><p>World</p></body></html>"),
		});

		const result = await webFetch("https://example.com", "markdown", 30);
		expect(result.content).toContain("# Hello");
		expect(result.content).toContain("World");
	});

	it("converts HTML to plain text", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			url: "https://example.com",
			headers: new Headers({ "content-type": "text/html" }),
			text: () => Promise.resolve("<html><body><p>Hello World</p></body></html>"),
		});

		const result = await webFetch("https://example.com", "text", 30);
		expect(result.content.trim()).toBe("Hello World");
	});

	it("returns raw HTML in html format", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			url: "https://example.com",
			headers: new Headers({ "content-type": "text/html" }),
			text: () => Promise.resolve("<html>raw</html>"),
		});

		const result = await webFetch("https://example.com", "html", 30);
		expect(result.content).toContain("<html>");
	});

	it("formats JSON responses", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			url: "https://api.example.com",
			headers: new Headers({ "content-type": "application/json" }),
			text: () => Promise.resolve('{"key":"value"}'),
		});

		const result = await webFetch("https://api.example.com", "text", 30);
		expect(result.content).toContain('"key"');
	});

	it("throws on non-2xx", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 404,
			headers: new Headers({ "content-type": "text/html" }),
			text: () => Promise.resolve("Not Found"),
		});

		await expect(webFetch("https://example.com", "text", 30)).rejects.toThrow("404");
	});

	it("rejects invalid URLs", async () => {
		await expect(webFetch("not-a-url", "text", 30)).rejects.toThrow("Invalid URL");
	});

	it("truncates content over 100K characters", async () => {
		const longText = "a".repeat(150_000);
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			url: "https://example.com",
			headers: new Headers({ "content-type": "text/plain" }),
			text: () => Promise.resolve(longText),
		});

		const result = await webFetch("https://example.com", "text", 30);
		expect(result.content.length).toBeLessThan(150_000);
		expect(result.content).toContain("truncated");
	});
});
