import { describe, expect, it } from "vitest";
import {
	isBinaryContentType,
	isHtmlContentType,
	isJsonContentType,
	looksLikeHtml,
	mediaType,
} from "../src/content_type.js";

describe("mediaType", () => {
	it("strips parameters and lowercases", () => {
		expect(mediaType("text/HTML; charset=UTF-8")).toBe("text/html");
		expect(mediaType("  application/JSON ")).toBe("application/json");
		expect(mediaType("")).toBe("");
	});
});

describe("isBinaryContentType", () => {
	it("rejects media and archive types", () => {
		for (const type of [
			"image/png",
			"image/svg+xml",
			"audio/mpeg",
			"video/mp4",
			"font/woff2",
			"application/pdf",
			"application/zip",
			"application/gzip",
			"application/octet-stream",
			"application/wasm",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		]) {
			expect(isBinaryContentType(type), type).toBe(true);
		}
	});

	it("keeps structured-suffix text types as text", () => {
		expect(isBinaryContentType("application/vnd.api+json")).toBe(false);
		expect(isBinaryContentType("application/atom+xml")).toBe(false);
		expect(isBinaryContentType("application/ld+json")).toBe(false);
	});

	it("keeps plain text and unknown types as text", () => {
		for (const type of ["text/html", "text/plain; charset=utf-8", "application/json", "", "application/x-whatever"]) {
			expect(isBinaryContentType(type), type).toBe(false);
		}
	});
});

describe("isHtmlContentType", () => {
	it("detects html media types only", () => {
		expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
		expect(isHtmlContentType("application/xhtml+xml")).toBe(true);
		expect(isHtmlContentType("text/plain")).toBe(false);
		expect(isHtmlContentType("application/json")).toBe(false);
	});
});

describe("isJsonContentType", () => {
	it("detects json and json-suffixed types", () => {
		expect(isJsonContentType("application/json")).toBe(true);
		expect(isJsonContentType("text/json")).toBe(true);
		expect(isJsonContentType("application/vnd.api+json")).toBe(true);
		expect(isJsonContentType("application/xml")).toBe(false);
	});
});

describe("looksLikeHtml", () => {
	it("detects html documents by prefix", () => {
		expect(looksLikeHtml("<!doctype html><html><body>x</body></html>")).toBe(true);
		expect(looksLikeHtml("  <HTML lang=\"en\"><body>x</body></HTML>")).toBe(true);
		expect(looksLikeHtml("\uFEFF<html><body>x</body></html>")).toBe(true);
	});

	it("does not flag fragments or plain text", () => {
		expect(looksLikeHtml("<p>hi</p>")).toBe(false);
		expect(looksLikeHtml("const xs: Array<string> = [];")).toBe(false);
		expect(looksLikeHtml("")).toBe(false);
	});
});
