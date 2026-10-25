import { describe, expect, it } from "vitest";
import { REMOVE_SELECTORS, htmlToMarkdown } from "../src/html_to_markdown.js";

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

	it("removes every REMOVE_SELECTORS element even inside the winning container", () => {
		// 所有待删元素都放进胜出的 <main>：若 removeNonContent 不生效，标记文本会直接漏进 content
		// （标记故意不用下划线等 markdown 特殊字符：turndown 会把 "_" 转义成 "\_"，导致断言假通过）
		const html = [
			"<html><body><main><h1>Comfy Skills</h1><p>Real content here.</p>",
			'<script type="application/json">{"marker":"SCRIPTJUNK"}</script>',
			'<style>.junk::before { content: "STYLEJUNK"; }</style>',
			"<noscript>NOSCRIPTJUNK</noscript>",
			// domino 会把 <template> 的子节点丢进不可访问的 content fragment，
			// 所以 TEMPLATEJUNK 只是金丝雀：真正提供载荷的是下面的 svg/iframe/canvas
			"<template><p>TEMPLATEJUNK</p></template>",
			"<svg><text>SVGJUNK</text></svg>",
			'<iframe src="https://example.com">IFRAMEJUNK</iframe>',
			"<canvas>CANVASJUNK</canvas>",
			"</main></body></html>",
		].join("");

		const { content } = htmlToMarkdown(html);

		expect(content).toContain("# Comfy Skills");
		expect(content).toContain("Real content here.");
		expect(content).not.toContain("SCRIPTJUNK");
		expect(content).not.toContain("STYLEJUNK");
		expect(content).not.toContain("NOSCRIPTJUNK");
		expect(content).not.toContain("TEMPLATEJUNK");
		expect(content).not.toContain("SVGJUNK");
		expect(content).not.toContain("IFRAMEJUNK");
		expect(content).not.toContain("CANVASJUNK");
	});

	it("covers every selector listed in REMOVE_SELECTORS", () => {
		expect([...REMOVE_SELECTORS].sort()).toEqual(
			["canvas", "iframe", "noscript", "script", "style", "svg", "template"].sort(),
		);
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

	it("prefers <main> over an earlier <article> and an earlier [role=main]", () => {
		// 容器优先级只有在多种容器同时出现时才可观测：article 与 [role=main] 都排在 <main> 之前
		const html = [
			"<html><body>",
			'<div role="main"><h1>ROLEMAINMARKER</h1></div>',
			"<article><h1>ARTICLEMARKER</h1></article>",
			"<main><h1>Main Wins</h1><p>Main body text.</p></main>",
			"</body></html>",
		].join("");

		const { content } = htmlToMarkdown(html);

		expect(content).toContain("# Main Wins");
		expect(content).toContain("Main body text.");
		expect(content).not.toContain("ROLEMAINMARKER");
		expect(content).not.toContain("ARTICLEMARKER");
	});

	it("keeps nav, aside and footer inside the winning container", () => {
		const html = [
			"<html><body><nav>OUTERNAVJUNK</nav>",
			"<main><h1>Doc Title</h1><nav>INNERNAV</nav><p>Main body text.</p>",
			"<aside>INNERASIDE</aside><footer>INNERFOOTER</footer></main>",
			"</body></html>",
		].join("");

		const { content } = htmlToMarkdown(html);

		expect(content).toContain("# Doc Title");
		expect(content).toContain("INNERNAV");
		expect(content).toContain("INNERASIDE");
		expect(content).toContain("INNERFOOTER");
		expect(content).not.toContain("OUTERNAVJUNK");
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
