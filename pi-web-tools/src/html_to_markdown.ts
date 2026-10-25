import { createDocument, type DomDocument, type DomNode } from "@mixmark-io/domino";
import TurndownService from "turndown";

/** 非正文元素：脚本、样式、模板与嵌入内容，一律先摘除再转 markdown */
export const REMOVE_SELECTORS: readonly string[] = [
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"iframe",
	"canvas",
];

/** 正文容器候选，按优先级排列（不支持逗号选择器：domino 会按文档顺序返回首个匹配） */
export const CONTENT_SELECTORS: readonly string[] = ["main", "article", "[role=main]"];

export interface ExtractedHtml {
	content: string;
	title?: string;
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

function removeNonContent(doc: DomDocument): void {
	for (const selector of REMOVE_SELECTORS) {
		// domino 返回的 NodeList 不可迭代，必须先 Array.from
		for (const node of Array.from(doc.querySelectorAll(selector))) {
			node.parentNode?.removeChild(node);
		}
	}
}

function selectContentNodes(doc: DomDocument): DomNode[] {
	for (const selector of CONTENT_SELECTORS) {
		const matches = Array.from(doc.querySelectorAll(selector)).filter((el) => el.textContent?.trim());
		if (matches.length > 0) return matches;
	}
	const fallback = doc.body ?? doc.documentElement;
	return [fallback];
}

export function htmlToMarkdown(html: string): ExtractedHtml {
	const doc = createDocument(html, true);
	// title 要在删除 <head> 内元素之前取
	const title = doc.title?.trim() || undefined;

	removeNonContent(doc);

	const content = selectContentNodes(doc)
		.map((node) => turndown.turndown(node))
		.join("\n\n");

	return { content, title };
}
