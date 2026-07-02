import { describe, it, expect } from "vitest";
import { buildFrontmatter, appendContent, isEmptyAfterRemove, type TopicMeta } from "../src/topic-file";

const meta: TopicMeta = { name: "go-api-setup", description: "Go project setup", type: "project", updated: "2026-07-02" };

describe("buildFrontmatter", () => {
	it("produces YAML frontmatter block", () => {
		const f = buildFrontmatter(meta);
		expect(f).toContain("---");
		expect(f).toContain("name: go-api-setup");
		expect(f).toContain("description: Go project setup");
		expect(f.startsWith("---\n")).toBe(true);
		expect(f.endsWith("---\n\n")).toBe(true);
	});
});

describe("appendContent", () => {
	it("creates a new file with heading when existing is null", () => {
		const out = appendContent(null, "SSH Gotcha", "staging uses port 2222");
		expect(out).toContain("# SSH Gotcha");
		expect(out).toContain("staging uses port 2222");
	});
	it("appends a new section to existing content", () => {
		const existing = "# Go API Project\n\n## Commands\n- make test";
		const out = appendContent(existing, "SSH Gotcha", "staging uses port 2222");
		expect(out).toContain("# Go API Project");
		expect(out).toContain("## SSH Gotcha");
		expect(out).toContain("staging uses port 2222");
		expect(out.startsWith("# Go API Project")).toBe(true);
	});
});

describe("isEmptyAfterRemove", () => {
	it("returns true for empty/whitespace string", () => {
		expect(isEmptyAfterRemove("")).toBe(true);
		expect(isEmptyAfterRemove("   \n\n  ")).toBe(true);
	});
	it("returns false for non-empty content", () => {
		expect(isEmptyAfterRemove("# Title\n\ncontent")).toBe(false);
	});
});
