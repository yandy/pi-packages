import { describe, it, expect } from "vitest";
import {
  parseIndex,
  serializeIndex,
  addEntry,
  removeEntryByTitle,
  matchEntryByTitle,
  truncateForInjection,
  checkCapacity,
  type IndexEntry,
} from "../src/index-file";

const SAMPLE = `- [Go API Setup](architecture.md)
- [Build Commands](builds.md)
- [SSH Gotcha](debugging.md)`;

describe("parseIndex", () => {
  it("parses pointer lines into entries (no description)", () => {
    const f = parseIndex(SAMPLE);
    expect(f.entries).toHaveLength(3);
    expect(f.entries[0]).toMatchObject({ title: "Go API Setup", topic: "architecture.md" });
  });
  it("allows multiple lines for the same topic", () => {
    const multi = `- [SSH Gotcha](debugging.md)\n- [MySQL Timeout](debugging.md)`;
    const f = parseIndex(multi);
    expect(f.entries).toHaveLength(2);
    expect(f.entries[0].topic).toBe("debugging.md");
    expect(f.entries[1].topic).toBe("debugging.md");
  });
  it("ignores blank lines and non-pointer lines", () => {
    const f = parseIndex(`# Memory\n\n${SAMPLE}\n\nsome note`);
    expect(f.entries).toHaveLength(3);
  });
});

describe("serializeIndex", () => {
  it("round-trips entries without description", () => {
    const f = parseIndex(SAMPLE);
    expect(serializeIndex(f.entries)).toBe(SAMPLE);
  });
});

describe("addEntry", () => {
  it("always pushes (never replaces)", () => {
    const entries: IndexEntry[] = [
      { title: "First", topic: "a.md", raw: "" },
    ];
    const next = addEntry(entries, { title: "Second", topic: "a.md", raw: "" });
    expect(next).toHaveLength(2);
    expect(next[0].title).toBe("First");
    expect(next[1].title).toBe("Second");
  });
  it("does not modify the original array", () => {
    const entries: IndexEntry[] = [{ title: "A", topic: "a.md", raw: "" }];
    addEntry(entries, { title: "B", topic: "b.md", raw: "" });
    expect(entries).toHaveLength(1);
  });
});

describe("removeEntryByTitle", () => {
  it("removes the entry with matching title", () => {
    const f = parseIndex(SAMPLE);
    const next = removeEntryByTitle(f.entries, "Build Commands");
    expect(next).toHaveLength(2);
    expect(next.find((e) => e.title === "Build Commands")).toBeUndefined();
  });
  it("throws when title not found", () => {
    const f = parseIndex(SAMPLE);
    expect(() => removeEntryByTitle(f.entries, "NoSuch")).toThrow("not found");
  });
  it("removes only the first match when duplicates exist", () => {
    const entries: IndexEntry[] = [
      { title: "Dup", topic: "a.md", raw: "" },
      { title: "Dup", topic: "b.md", raw: "" },
    ];
    const next = removeEntryByTitle(entries, "Dup");
    expect(next).toHaveLength(1);
    expect(next[0].topic).toBe("b.md");
  });
});

describe("matchEntryByTitle", () => {
  it("returns unique match", () => {
    const f = parseIndex(SAMPLE);
    const result = matchEntryByTitle(f.entries, "SSH Gotcha");
    expect(result.unique).toBe(true);
    expect(result.entry).toMatchObject({ title: "SSH Gotcha", topic: "debugging.md" });
  });
  it("returns null with unique=false when no match", () => {
    const f = parseIndex(SAMPLE);
    const result = matchEntryByTitle(f.entries, "NoSuch");
    expect(result.unique).toBe(false);
    expect(result.entry).toBeNull();
  });
  it("returns first match with unique=false when multiple", () => {
    const entries: IndexEntry[] = [
      { title: "Dup", topic: "a.md", raw: "" },
      { title: "Dup", topic: "b.md", raw: "" },
    ];
    const result = matchEntryByTitle(entries, "Dup");
    expect(result.unique).toBe(false);
    expect(result.entry).toBeDefined();
  });
});

describe("truncateForInjection", () => {
  it("keeps content under limits", () => {
    const r = truncateForInjection(SAMPLE, 200, 25600);
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(false);
  });
  it("truncates by line count", () => {
    const many = Array.from({ length: 10 }, (_, i) => `- [T${i}](t${i}.md)`).join("\n");
    const r = truncateForInjection(many, 3, 25600);
    expect(r.truncated).toBe(true);
    expect(r.content.split("\n").length).toBe(4);
    expect(r.content).toContain("[truncated:");
  });
  it("truncates by byte count", () => {
    const longLine = `- [A very long title that exceeds the byte limit](example.md)`;
    const r = truncateForInjection(longLine, 100, 50);
    expect(r.truncated).toBe(true);
    const beforeMarker = r.content.split("\n")[0];
    expect(Buffer.byteLength(beforeMarker, "utf8")).toBeLessThanOrEqual(50);
  });
});

describe("checkCapacity", () => {
  it("returns true under limits", () => {
    const f = parseIndex(SAMPLE);
    expect(checkCapacity(f.entries, 200, 25600)).toBe(true);
  });
  it("returns false when over line limit", () => {
    const many: IndexEntry[] = Array.from({ length: 201 }, (_, i) => ({
      title: `T${i}`, topic: `t${i}.md`, raw: "",
    }));
    expect(checkCapacity(many, 200, 25600)).toBe(false);
  });
});
