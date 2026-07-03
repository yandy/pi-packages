import { describe, it, expect } from "vitest";
import {
  buildFrontmatter,
  appendContent,
  updateFrontmatterDate,
  removeEntrySection,
  hasEntries,
  parseEntries,
  type TopicMeta,
} from "../src/topic-file";

const meta: TopicMeta = { updated: "2026-07-03" };

describe("buildFrontmatter", () => {
  it("produces YAML frontmatter with only updated", () => {
    const f = buildFrontmatter(meta);
    expect(f).toBe("---\nupdated: 2026-07-03\n---\n\n");
  });
});

describe("appendContent", () => {
  it("creates file with ## heading (no # level-1) when existing is null", () => {
    const out = appendContent(null, "SSH Gotcha", "staging uses port 2222");
    expect(out).toBe("## SSH Gotcha\n\nstaging uses port 2222");
    expect(out).not.toMatch(/^# /m);
  });
  it("appends a new ## section to existing content", () => {
    const existing = "## Commands\n\n- make test";
    const out = appendContent(existing, "SSH Gotcha", "staging uses port 2222");
    expect(out).toContain("## Commands");
    expect(out).toContain("## SSH Gotcha");
    expect(out).toContain("staging uses port 2222");
    expect(out.startsWith("## Commands")).toBe(true);
  });
  it("appends to empty string like a new file", () => {
    const out = appendContent("", "Solo", "content");
    expect(out).toBe("## Solo\n\ncontent");
  });
});

describe("updateFrontmatterDate", () => {
  it("updates updated field in frontmatter", () => {
    const raw = "---\nupdated: 2026-07-01\n---\n\n## Entry\nbody";
    const result = updateFrontmatterDate(raw, "2026-07-03");
    expect(result).toContain("updated: 2026-07-03");
    expect(result).not.toContain("updated: 2026-07-01");
    expect(result).toContain("## Entry\nbody");
  });
  it("leaves non-frontmatter content unchanged", () => {
    const raw = "## Just content\nno frontmatter";
    const result = updateFrontmatterDate(raw, "2026-07-03");
    expect(result).toBe(raw);
  });
});

describe("removeEntrySection", () => {
  const twoEntries = [
    "---",
    "updated: 2026-07-03",
    "---",
    "",
    "## SSH Gotcha",
    "staging uses port 2222",
    "",
    "## MySQL Timeout",
    "connection timeout after 30s",
  ].join("\n");

  it("removes first entry section and its leading blank lines", () => {
    const result = removeEntrySection(twoEntries, "SSH Gotcha");
    expect(result).not.toContain("SSH Gotcha");
    expect(result).not.toContain("staging uses port 2222");
    expect(result).toContain("## MySQL Timeout");
    expect(result).toContain("updated: 2026-07-03");
  });
  it("removes last entry section", () => {
    const result = removeEntrySection(twoEntries, "MySQL Timeout");
    expect(result).not.toContain("MySQL Timeout");
    expect(result).not.toContain("connection timeout after 30s");
    expect(result).toContain("## SSH Gotcha");
  });
  it("removes the only entry, leaving just frontmatter and trailing newline", () => {
    const solo = "---\nupdated: 2026-07-03\n---\n\n## Only\ncontent";
    const result = removeEntrySection(solo, "Only");
    expect(result).not.toContain("## Only");
    expect(result).not.toContain("content");
    expect(result).toContain("updated: 2026-07-03");
  });
  it("throws when title not found", () => {
    expect(() => removeEntrySection(twoEntries, "NoSuch")).toThrow("not found");
  });
});

describe("hasEntries", () => {
  it("returns true when ## headings exist", () => {
    expect(hasEntries("## Entry\nbody")).toBe(true);
    expect(hasEntries("---\nupdated: x\n---\n\n## E\nc")).toBe(true);
  });
  it("returns false when no ## headings", () => {
    expect(hasEntries("")).toBe(false);
    expect(hasEntries("---\nupdated: x\n---\n\n")).toBe(false);
    expect(hasEntries("just text no headings")).toBe(false);
  });
});

describe("parseEntries", () => {
  it("parses entries from a topic file", () => {
    const raw = [
      "---",
      "updated: 2026-07-03",
      "---",
      "",
      "## SSH Gotcha",
      "staging uses port 2222",
      "",
      "## MySQL Timeout",
      "connection timeout after 30s",
    ].join("\n");
    const entries = parseEntries(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ title: "SSH Gotcha", content: "staging uses port 2222" });
    expect(entries[1]).toEqual({ title: "MySQL Timeout", content: "connection timeout after 30s" });
  });
  it("returns empty array for no entries", () => {
    expect(parseEntries("")).toEqual([]);
    expect(parseEntries("---\nupdated: x\n---\n\n")).toEqual([]);
  });
  it("handles multi-line entry content", () => {
    const raw = "## Multi\nline 1\n\nline 2\n\nmore\n\n## Next\nsingle";
    const entries = parseEntries(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toBe("line 1\n\nline 2\n\nmore");
  });
});
