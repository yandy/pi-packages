import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/html_to_markdown.js";

describe("htmlToMarkdown", () => {
	it("drops script, style and other non-content elements", () => {
		const html = [
			"<html><head><style>:root { --tab-size-preference: 4; }</style></head><body>",
			'<script type="application/json">{"featureFlags":["copilot_agent_merge_fix_ci"]}</script>',
			"<noscript>enable javascript</noscript><template><p>template-text</p></template>",
			'<svg><path d="M12 2C6.48 2 2"/></svg><iframe src="https://example.com"></iframe>',
			"<main><h1>Comfy Skills</h1><p>Real content here.</p></main></body></html>",
		].join("");

		const { content } = htmlToMarkdown(html);

		expect(content).toContain("# Comfy Skills");
		expect(content).toContain("Real content here.");
		expect(content).not.toContain("featureFlags");
		expect(content).not.toContain("tab-size-preference");
		expect(content).not.toContain("enable javascript");
		expect(content).not.toContain("template-text");
		expect(content).not.toContain("M12 2C6.48");
	});

	it("returns <title> as title and keeps it out of the content", () => {
		const html =
			"<html><head><title>Comfy Cloud Product Skills</title></head><body><main><p>Body copy.</p></main></body></html>";

		const { content, title } = htmlToMarkdown(html);

		expect(title).toBe("Comfy Cloud Product Skills");
		expect(content).not.toContain("Comfy Cloud Product Skills");
	});

	it("leaves title undefined when the page has no <title>", () => {
		const { title } = htmlToMarkdown("<html><body><main><p>No title here.</p></main></body></html>");
		expect(title).toBeUndefined();
	});

	it("prefers <main> and drops chrome outside it", () => {
		const html = [
			"<html><body><nav>NAVIGATION JUNK</nav>",
			"<main><h1>Doc Title</h1><p>Main body text.</p></main>",
			"<footer>FOOTER JUNK</footer></body></html>",
		].join("");

		const { content } = htmlToMarkdown(html);

		expect(content).toContain("# Doc Title");
		expect(content).toContain("Main body text.");
		expect(content).not.toContain("NAVIGATION JUNK");
		expect(content).not.toContain("FOOTER JUNK");
	});

	it("falls back to <article> when there is no <main>", () => {
		const { content } = htmlToMarkdown(
			"<html><body><nav>NAV JUNK</nav><article><h1>Article Title</h1></article></body></html>",
		);
		expect(content).toContain("# Article Title");
		expect(content).not.toContain("NAV JUNK");
	});

	it("falls back to [role=main] when there is no <main> or <article>", () => {
		const { content } = htmlToMarkdown(
			'<html><body><nav>NAV JUNK</nav><div role="main"><h1>Role Main Title</h1></div></body></html>',
		);
		expect(content).toContain("# Role Main Title");
		expect(content).not.toContain("NAV JUNK");
	});

	it("falls back to <body> when no content container exists", () => {
		const { content } = htmlToMarkdown(
			"<html><body><div><h1>Loose Title</h1><p>Loose body.</p></div></body></html>",
		);
		expect(content).toContain("# Loose Title");
		expect(content).toContain("Loose body.");
	});

	it("skips an empty <main> and uses the next container", () => {
		const { content } = htmlToMarkdown(
			"<html><body><main>   </main><article><h1>Fallback Article</h1></article></body></html>",
		);
		expect(content).toContain("# Fallback Article");
	});

	it("concatenates every non-empty match of the winning selector", () => {
		const html = [
			"<html><body>",
			"<article><h2>Card One</h2><p>First card body.</p></article>",
			"<article><h2>Card Two</h2><p>Second card body.</p></article>",
			"</body></html>",
		].join("");

		const { content } = htmlToMarkdown(html);

		expect(content).toContain("Card One");
		expect(content).toContain("First card body.");
		expect(content).toContain("Card Two");
		expect(content).toContain("Second card body.");
	});

	it("returns empty content for an empty shell page", () => {
		const { content } = htmlToMarkdown("<html><body><div></div></body></html>");
		expect(content.trim()).toBe("");
	});
});
