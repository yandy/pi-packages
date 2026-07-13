import { describe, it, expect } from "vitest";
import {
  parseIndex,
  serializeIndex,
  upsertEntryByTopic,
  removeEntryByTopic,
  findEntryByTopic,
  updateHook,
  truncateForInjection,
  checkCapacity,
  type IndexEntry,
} from "../src/index-file";

const SAMPLE = `- [Architecture](architecture.md) — Go API setup patterns
- [Builds](builds.md) — npm scripts and make targets
- [Debugging](debugging.md) — SSH port 2222, MySQL timeout`;

describe("parseIndex", () => {
  it("parses per-topic lines with hooks", () => {
    const f = parseIndex(SAMPLE);
    expect(f.entries).toHaveLength(3);
    expect(f.entries[0]).toMatchObject({
      name: "Architecture",
      topic: "architecture.md",
      hook: "Go API setup patterns",
    });
  });
  it("ignores blank lines and non-pointer lines", () => {
    const f = parseIndex(`# Memory\n\n${SAMPLE}\n\nsome note`);
    expect(f.entries).toHaveLength(3);
  });
  it("allows only one entry per topic (parse discards duplicates, keeping last)", () => {
    const dup = `- [A](x.md) — first\n- [B](x.md) — second`;
    const f = parseIndex(dup);
    expect(f.entries).toHaveLength(2); // parse 不负责去重
  });
});

describe("serializeIndex", () => {
  it("round-trips entries with hooks", () => {
    const f = parseIndex(SAMPLE);
    expect(serializeIndex(f.entries)).toBe(SAMPLE);
  });
  it("writes empty hook without hang", () => {
    const entries = [{ name: "New", topic: "n.md", hook: "", raw: "" }];
    expect(serializeIndex(entries)).toBe("- [New](n.md) — ");
  });
});

describe("upsertEntryByTopic", () => {
  it("adds new entry when topic not present", () => {
    const entries = parseIndex(SAMPLE).entries;
    const next = upsertEntryByTopic(entries, { name: "New", topic: "n.md", hook: "desc", raw: "" });
    expect(next).toHaveLength(4);
    expect(next[3]).toMatchObject({ name: "New", topic: "n.md", hook: "desc" });
  });
  it("replaces existing entry when topic matches", () => {
    const entries = parseIndex(SAMPLE).entries;
    const next = upsertEntryByTopic(entries, { name: "Debugging V2", topic: "debugging.md", hook: "updated hook", raw: "" });
    expect(next).toHaveLength(3); // same count
    const found = next.find(e => e.topic === "debugging.md");
    expect(found).toMatchObject({ name: "Debugging V2", hook: "updated hook" });
  });
  it("does not modify original array", () => {
    const entries: IndexEntry[] = [{ name: "A", topic: "a.md", hook: "h", raw: "" }];
    upsertEntryByTopic(entries, { name: "B", topic: "b.md", hook: "h2", raw: "" });
    expect(entries).toHaveLength(1);
  });
});

describe("removeEntryByTopic", () => {
  it("removes entry by topic filename", () => {
    const entries = parseIndex(SAMPLE).entries;
    const next = removeEntryByTopic(entries, "builds.md");
    expect(next).toHaveLength(2);
    expect(next.find(e => e.topic === "builds.md")).toBeUndefined();
  });
  it("throws when topic not found", () => {
    const entries = parseIndex(SAMPLE).entries;
    expect(() => removeEntryByTopic(entries, "nonexistent.md")).toThrow("not found");
  });
});

describe("findEntryByTopic", () => {
  it("returns entry for matching topic", () => {
    const entries = parseIndex(SAMPLE).entries;
    const e = findEntryByTopic(entries, "debugging.md");
    expect(e).toBeDefined();
    expect(e!.name).toBe("Debugging");
  });
  it("returns null for non-matching topic", () => {
    const entries = parseIndex(SAMPLE).entries;
    expect(findEntryByTopic(entries, "nonexistent.md")).toBeNull();
  });
});

describe("updateHook", () => {
  it("updates hook for matching topic", () => {
    const entries = parseIndex(SAMPLE).entries;
    const next = updateHook(entries, "debugging.md", "new hook text");
    const found = next.find(e => e.topic === "debugging.md");
    expect(found!.hook).toBe("new hook text");
  });
  it("throws when topic not found", () => {
    const entries = parseIndex(SAMPLE).entries;
    expect(() => updateHook(entries, "nonexistent.md", "h")).toThrow("not found");
  });
});

describe("truncateForInjection", () => {
  it("keeps content under limits", () => {
    const r = truncateForInjection(SAMPLE, 200, 25600);
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(false);
  });
  it("truncates by line count", () => {
    const many = Array.from({ length: 10 }, (_, i) => `- [T${i}](t${i}.md) — desc`).join("\n");
    const r = truncateForInjection(many, 3, 25600);
    expect(r.truncated).toBe(true);
    expect(r.content.split("\n").length).toBe(4);
    expect(r.content).toContain("[truncated:");
  });
  it("truncates by byte count", () => {
    const longLine = `- [A very long title that exceeds the byte limit](example.md) — hook`;
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
      name: `T${i}`, topic: `t${i}.md`, hook: "desc", raw: "",
    }));
    expect(checkCapacity(many, 200, 25600)).toBe(false);
  });
});
