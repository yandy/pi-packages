# pi-memory v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild pi-memory at entry granularity: one topic file → multiple `##` entries, add appends (no upsert), remove/read by entry title, search returns full entry blocks, dream consolidates entries.

**Architecture:** Progressive refactor — modify existing files in-place (topic-file.ts, index-file.ts, memory-tool.ts, dream.ts, index.ts). No new modules. Each unit testable independently.

**Tech Stack:** TypeScript, vitest, typebox (schema), @earendil-works/pi-coding-agent SDK.

## Global Constraints

- Version: `@yandy0725/pi-memory@0.1.0` → bump to `0.2.0`
- No external runtime dependencies beyond node built-ins + pi SDK + typebox
- Package root: `pi-memory/`
- Worktree: `.worktrees/feat-pi-memory-auto-recall/pi-memory/`

---

### Task 1: topic-file.ts — Frontmatter Simplification + Entry Operations

**Files:**
- Modify: `pi-memory/src/topic-file.ts`
- Modify: `pi-memory/tests/topic-file.test.ts`

**Interfaces:**
- Produces: `TopicMeta { updated: string }`, `buildFrontmatter(meta)`, `appendContent(existing, entryTitle, content)`, `updateFrontmatterDate(raw, date)`, `removeEntrySection(raw, title)`, `hasEntries(raw)`, `parseEntries(raw)`
- Removes: `isEmptyAfterRemove`
- Changes: `TopicMeta` drops `name`/`description`/`type`

---

- [ ] **Step 1: Rewrite tests for new API**

Replace `pi-memory/tests/topic-file.test.ts`:

```ts
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
    expect(out).not.toContain("# SSH Gotcha");
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
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd pi-memory && npx vitest run tests/topic-file.test.ts
```

Expected: FAIL — `updateFrontmatterDate`, `removeEntrySection`, `hasEntries`, `parseEntries` not exported; `buildFrontmatter` output mismatch.

- [ ] **Step 3: Implement new topic-file.ts**

Replace `pi-memory/src/topic-file.ts`:

```ts
export interface TopicMeta {
  updated: string;
}

export function buildFrontmatter(meta: TopicMeta): string {
  return `---\nupdated: ${meta.updated}\n---\n\n`;
}

export function appendContent(
  existing: string | null,
  entryTitle: string,
  content: string,
): string {
  const section = `## ${entryTitle}\n\n${content}`;
  if (!existing || existing.trim() === "") return section;
  return `${existing.trimEnd()}\n\n${section}\n`;
}

export function updateFrontmatterDate(raw: string, date: string): string {
  return raw.replace(/^(---\n)updated: .+(\n---)/m, `$1updated: ${date}$2`);
}

export function removeEntrySection(raw: string, title: string): string {
  const marker = `## ${title}`;
  // find start of this entry block
  const startIdx = raw.indexOf(`\n${marker}\n`) !== -1
    ? raw.indexOf(`\n${marker}\n`)
    : raw.indexOf(marker);
  if (startIdx === -1) throw new Error(`Entry "${title}" not found`);

  // find start of next ## or EOF
  const afterHeader = raw.indexOf("\n", startIdx + marker.length);
  const nextH2 = raw.indexOf("\n## ", afterHeader + 1);
  const endIdx = nextH2 === -1 ? raw.length : nextH2;

  // remove including preceding blank lines
  let cutStart = startIdx;
  while (cutStart > 0 && raw[cutStart - 1] === "\n") cutStart--;
  // also strip one more \n if present (the blank line separator)
  if (cutStart > 0 && raw[cutStart - 1] === "\n") cutStart--;

  let result = raw.slice(0, cutStart) + raw.slice(endIdx);
  // ensure exactly one trailing newline
  result = result.replace(/\n{3,}$/, "\n\n").replace(/\n{2,}$/, "\n");
  if (!result.endsWith("\n")) result += "\n";
  return result;
}

export function hasEntries(raw: string): boolean {
  return /^## /m.test(raw);
}

export interface ParsedEntry {
  title: string;
  content: string;
}

export function parseEntries(raw: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const lines = raw.split("\n");
  let currentTitle = "";
  let currentContent: string[] = [];
  let inEntry = false;
  let inFrontmatter = false;

  for (const line of lines) {
    if (line === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;

    const h2 = line.match(/^## (.+)$/);
    if (h2) {
      if (inEntry) {
        entries.push({ title: currentTitle, content: currentContent.join("\n").trim() });
      }
      currentTitle = h2[1];
      currentContent = [];
      inEntry = true;
      continue;
    }
    if (inEntry) {
      currentContent.push(line);
    }
  }
  if (inEntry) {
    entries.push({ title: currentTitle, content: currentContent.join("\n").trim() });
  }
  return entries;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd pi-memory && npx vitest run tests/topic-file.test.ts
```

Expected: all 14 tests PASS.

- [ ] **Step 5: Typecheck**

```bash
cd pi-memory && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add pi-memory/src/topic-file.ts pi-memory/tests/topic-file.test.ts
git commit -m "refactor(pi-memory): entry-granular topic-file — simplified frontmatter, entry section ops"
```

---

### Task 2: index-file.ts — Entry-Level Index Operations

**Files:**
- Modify: `pi-memory/src/index-file.ts`
- Modify: `pi-memory/tests/index-file.test.ts`

**Interfaces:**
- Produces: `IndexEntry { title, topic, raw }` (no `description`), `addEntry(entries, entry)`, `removeEntryByTitle(entries, title)`, `matchEntryByTitle(entries, title)`
- Removes: `upsertEntry`
- Changes: index line format `- [title](topic)` (no ` — description`)

---

- [ ] **Step 1: Rewrite tests for new index API**

Replace `pi-memory/tests/index-file.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd pi-memory && npx vitest run tests/index-file.test.ts
```

Expected: FAIL — `addEntry`, `removeEntryByTitle`, `matchEntryByTitle` not exported; `upsertEntry` test imports fail; parse/serialize format mismatch.

- [ ] **Step 3: Implement new index-file.ts**

Replace `pi-memory/src/index-file.ts`:

```ts
export interface IndexEntry {
  title: string;
  topic: string;
  raw: string;
}
export interface IndexFile {
  entries: IndexEntry[];
  raw: string;
}

// Matches: - [Title](topic.md)
const LINE_RE = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*$/;

export function parseIndex(content: string): IndexFile {
  const entries: IndexEntry[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(LINE_RE);
    if (m) entries.push({ title: m[1].trim(), topic: m[2].trim(), raw: line });
  }
  return { entries, raw: content };
}

export function serializeIndex(entries: IndexEntry[]): string {
  return entries.map((e) => `- [${e.title}](${e.topic})`).join("\n");
}

export function addEntry(entries: IndexEntry[], entry: IndexEntry): IndexEntry[] {
  return [...entries, entry];
}

export function removeEntryByTitle(entries: IndexEntry[], title: string): IndexEntry[] {
  const idx = entries.findIndex((e) => e.title === title);
  if (idx === -1) throw new Error(`Entry "${title}" not found in index`);
  const next = [...entries];
  next.splice(idx, 1);
  return next;
}

export interface MatchResult {
  entry: IndexEntry | null;
  unique: boolean;
}

export function matchEntryByTitle(entries: IndexEntry[], title: string): MatchResult {
  const matches = entries.filter((e) => e.title === title);
  if (matches.length === 0) return { entry: null, unique: false };
  if (matches.length === 1) return { entry: matches[0], unique: true };
  return { entry: matches[0], unique: false };
}

export function truncateForInjection(
  content: string,
  maxLines: number,
  maxBytes: number,
): { ok: boolean; content: string; truncated: boolean } {
  const lines = content.split("\n");
  let out = content;
  let truncated = false;
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(out, "utf8") > maxBytes) {
    let cut = out;
    while (Buffer.byteLength(cut, "utf8") > maxBytes && cut.length > 0) cut = cut.slice(0, -1);
    out = cut;
    truncated = true;
  }
  if (truncated) out += `\n[truncated: memory index exceeds injection limit]`;
  return { ok: !truncated, content: out, truncated };
}

export function checkCapacity(
  entries: IndexEntry[],
  maxLines: number,
  maxBytes: number,
): boolean {
  const serialized = serializeIndex(entries);
  if (entries.length > maxLines) return false;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) return false;
  return true;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd pi-memory && npx vitest run tests/index-file.test.ts
```

Expected: all 16 tests PASS.

- [ ] **Step 5: Typecheck**

```bash
cd pi-memory && npx tsc --noEmit
```

Expected: no errors (may have pre-existing errors in memory-tool.ts from old imports — that's fine, fixed in Task 3).

- [ ] **Step 6: Commit**

```bash
git add pi-memory/src/index-file.ts pi-memory/tests/index-file.test.ts
git commit -m "refactor(pi-memory): entry-level index — addEntry/removeByTitle/matchByTitle, no description"
```

---

### Task 3: memory-tool.ts — doAdd + doRemove Rewrite

**Files:**
- Modify: `pi-memory/src/memory-tool.ts`
- Modify: `pi-memory/tests/memory-tool.test.ts`

**Interfaces:**
- Consumes: `addEntry`, `removeEntryByTitle`, `matchEntryByTitle`, `serializeIndex`, `parseIndex`, `checkCapacity` from `index-file.ts`; `buildFrontmatter`, `appendContent`, `updateFrontmatterDate`, `removeEntrySection`, `hasEntries` from `topic-file.ts`
- Changes: `AddParams` drops `description`, `title` required; `RemoveParams` becomes `{ entry: string }`; `ReplaceParams` removed
- Removes: `doReplace`, `findMatches`

---

- [ ] **Step 1: Rewrite memory-tool test (add + remove only)**

Replace `pi-memory/tests/memory-tool.test.ts`:

```ts
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { doAdd, doRemove } from "../src/memory-tool";

describe("doAdd", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-add-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("creates a new topic file with simplified frontmatter + MEMORY.md entry", async () => {
    const res = await doAdd(dir, {
      content: "staging uses port 2222",
      topic: "debugging.md",
      title: "SSH Gotcha",
      maxLines: 200,
      maxBytes: 25600,
    });
    expect(res.ok).toBe(true);
    const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(mem).toContain("[SSH Gotcha](debugging.md)");
    // no description
    expect(mem).not.toContain(" \u2014 ");
    const topic = await readFile(join(dir, "debugging.md"), "utf8");
    expect(topic).toContain("staging uses port 2222");
    expect(topic).toContain("updated:");
    // no # level-1 heading, no old frontmatter fields
    expect(topic).not.toContain("# SSH Gotcha");
    expect(topic).not.toContain("name:");
    expect(topic).not.toContain("description:");
    expect(topic).not.toContain("type:");
  });

  it("appends second entry to same topic (multi-entry, no upsert)", async () => {
    await doAdd(dir, {
      content: "first note",
      topic: "debugging.md",
      title: "SSH Gotcha",
      maxLines: 200,
      maxBytes: 25600,
    });
    const res = await doAdd(dir, {
      content: "second note",
      topic: "debugging.md",
      title: "MySQL Timeout",
      maxLines: 200,
      maxBytes: 25600,
    });
    expect(res.ok).toBe(true);
    const topic = await readFile(join(dir, "debugging.md"), "utf8");
    expect(topic).toContain("## SSH Gotcha");
    expect(topic).toContain("first note");
    expect(topic).toContain("## MySQL Timeout");
    expect(topic).toContain("second note");
    const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
    // two lines for the same topic
    expect(mem).toContain("[SSH Gotcha](debugging.md)");
    expect(mem).toContain("[MySQL Timeout](debugging.md)");
  });

  it("refreshes updated date on append to existing topic", async () => {
    await doAdd(dir, {
      content: "first note",
      topic: "debugging.md",
      title: "Entry1",
      maxLines: 200,
      maxBytes: 25600,
    });
    const res = await doAdd(dir, {
      content: "second note",
      topic: "debugging.md",
      title: "Entry2",
      maxLines: 200,
      maxBytes: 25600,
    });
    expect(res.ok).toBe(true);
    const topic = await readFile(join(dir, "debugging.md"), "utf8");
    const today = new Date().toISOString().slice(0, 10);
    expect(topic).toContain(`updated: ${today}`);
  });

  it("rejects when over capacity", async () => {
    const res = await doAdd(dir, {
      content: "x",
      topic: "a.md",
      title: "A",
      maxLines: 0,
      maxBytes: 25600,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("capacity");
  });

  it("rejects path traversal topic", async () => {
    const res = await doAdd(dir, {
      content: "x",
      topic: "../escape.md",
      title: "A",
      maxLines: 200,
      maxBytes: 25600,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unsafe|traversal|escape/i);
  });

  it("rejects when title is missing", async () => {
    const res = await doAdd(dir, {
      content: "x",
      topic: "a.md",
      maxLines: 200,
      maxBytes: 25600,
    } as any);
    expect(res.ok).toBe(false);
  });

  it("parallel adds to different topics preserve both entries", async () => {
    const results = await Promise.all([
      doAdd(dir, {
        content: "staging port 2222",
        topic: "ssh.md",
        title: "SSH Staging",
        maxLines: 200,
        maxBytes: 25600,
      }),
      doAdd(dir, {
        content: "prod port 443",
        topic: "firewall.md",
        title: "Firewall",
        maxLines: 200,
        maxBytes: 25600,
      }),
    ]);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(true);
    const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(mem).toContain("[SSH Staging](ssh.md)");
    expect(mem).toContain("[Firewall](firewall.md)");
  });
});

describe("doRemove", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-rm-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("removes entry by title: deletes index line + ## block", async () => {
    await doAdd(dir, {
      content: "staging uses port 2222",
      topic: "debugging.md",
      title: "SSH Gotcha",
      maxLines: 200,
      maxBytes: 25600,
    });
    await doAdd(dir, {
      content: "connection timeout after 30s",
      topic: "debugging.md",
      title: "MySQL Timeout",
      maxLines: 200,
      maxBytes: 25600,
    });
    const res = await doRemove(dir, { entry: "SSH Gotcha" });
    expect(res.ok).toBe(true);
    const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(mem).not.toContain("[SSH Gotcha]");
    expect(mem).toContain("[MySQL Timeout]");
    const topic = await readFile(join(dir, "debugging.md"), "utf8");
    expect(topic).not.toContain("SSH Gotcha");
    expect(topic).not.toContain("staging uses port 2222");
    expect(topic).toContain("MySQL Timeout");
  });

  it("deletes topic file when last entry removed", async () => {
    await doAdd(dir, {
      content: "only entry",
      topic: "temp.md",
      title: "Temp",
      maxLines: 200,
      maxBytes: 25600,
    });
    const res = await doRemove(dir, { entry: "Temp" });
    expect(res.ok).toBe(true);
    await expect(readFile(join(dir, "temp.md"), "utf8")).rejects.toThrow();
    const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(mem).not.toContain("temp.md");
  });

  it("errors when entry not found", async () => {
    const res = await doRemove(dir, { entry: "NoSuch" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });

  it("errors on multiple matches", async () => {
    await doAdd(dir, {
      content: "x",
      topic: "a.md",
      title: "Dup",
      maxLines: 200,
      maxBytes: 25600,
    });
    await doAdd(dir, {
      content: "y",
      topic: "b.md",
      title: "Dup",
      maxLines: 200,
      maxBytes: 25600,
    });
    const res = await doRemove(dir, { entry: "Dup" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/multiple/i);
  });

  it("refreshes updated date after removing one entry from multi-entry topic", async () => {
    await doAdd(dir, {
      content: "first",
      topic: "misc.md",
      title: "Entry1",
      maxLines: 200,
      maxBytes: 25600,
    });
    await doAdd(dir, {
      content: "second",
      topic: "misc.md",
      title: "Entry2",
      maxLines: 200,
      maxBytes: 25600,
    });
    await doRemove(dir, { entry: "Entry1" });
    const topic = await readFile(join(dir, "misc.md"), "utf8");
    const today = new Date().toISOString().slice(0, 10);
    expect(topic).toContain(`updated: ${today}`);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd pi-memory && npx vitest run tests/memory-tool.test.ts
```

Expected: FAIL — `doReplace` test imports removed; `doAdd` uses new `AddParams` (no `description`); `doRemove` uses new `RemoveParams` (no `old_text`); old `findMatches` import removed; existing `doReplace` tests that import removed functions fail.

- [ ] **Step 3: Implement doAdd rewrite in memory-tool.ts**

**Partial edit — only change the `doAdd` function and types.** Open `pi-memory/src/memory-tool.ts` and replace the import block and doAdd:

```ts
// Replace imports at top of file:
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { parseIndex, serializeIndex, addEntry, removeEntryByTitle, matchEntryByTitle, checkCapacity, type IndexEntry } from "./index-file";
import { buildFrontmatter, appendContent, updateFrontmatterDate, removeEntrySection, hasEntries, parseEntries } from "./topic-file";
import { safeTopicPath } from "./paths";
```

Replace `AddParams` and `ReplaceParams` and `RemoveParams` and `ActionResult`:

```ts
export interface AddParams { content: string; topic: string; title: string; maxLines: number; maxBytes: number; }
export interface RemoveParams { entry: string; }
export interface ActionResult { ok: boolean; error?: string; entries?: IndexEntry[]; }
```

Replace `slug`, `today`, and the entire `doAdd` function:

```ts
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function doAdd(memoryDir: string, p: AddParams): Promise<ActionResult> {
  let topicPath: string;
  try {
    topicPath = safeTopicPath(memoryDir, p.topic);
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
  return withFileMutationQueue(join(memoryDir, "MEMORY.md"), async () => {
    await mkdir(dirname(topicPath), { recursive: true });
    const entries = await readIndex(memoryDir);
    const next = addEntry(entries, { title: p.title, topic: p.topic, raw: "" });
    if (!checkCapacity(next, p.maxLines, p.maxBytes)) {
      return {
        ok: false,
        error: `MEMORY.md capacity exceeded (max ${p.maxLines} lines / ${p.maxBytes} bytes). Current entries: ${serializeIndex(entries)}`,
      };
    }
    // write topic file
    let existing: string | null = null;
    try { existing = await readFile(topicPath, "utf8"); } catch { existing = null; }
    if (!existing) {
      const out = `${buildFrontmatter({ updated: today() })}${appendContent(null, p.title, p.content)}`;
      await writeFile(topicPath, out, "utf8");
    } else {
      const updated = updateFrontmatterDate(existing, today());
      const out = appendContent(updated, p.title, p.content);
      await writeFile(topicPath, out, "utf8");
    }
    // write index
    await writeFile(join(memoryDir, "MEMORY.md"), serializeIndex(next) + "\n", "utf8");
    return { ok: true, entries: next };
  });
}
```

- [ ] **Step 4: Implement doRemove rewrite**

Replace `doRemove` and remove `doReplace` and `findMatches`:

```ts
export async function doRemove(memoryDir: string, p: RemoveParams): Promise<ActionResult> {
  return withFileMutationQueue(join(memoryDir, "MEMORY.md"), async () => {
    const entries = await readIndex(memoryDir);
    const match = matchEntryByTitle(entries, p.entry);
    if (!match.entry) {
      return { ok: false, error: `Entry "${p.entry}" not found in index` };
    }
    if (!match.unique) {
      const matchingTopics = entries
        .filter((e) => e.title === p.entry)
        .map((e) => e.topic)
        .join(", ");
      return { ok: false, error: `Multiple matches for entry "${p.entry}" in topics: ${matchingTopics}` };
    }

    const topicFile = match.entry.topic;
    const topicPath = safeTopicPath(memoryDir, topicFile);

    // remove index line
    const updated = removeEntryByTitle(entries, p.entry);
    await writeFile(join(memoryDir, "MEMORY.md"), serializeIndex(updated) + "\n", "utf8");

    // remove ## block from topic file
    try {
      const raw = await readFile(topicPath, "utf8");
      const afterRemoval = removeEntrySection(raw, p.entry);
      if (hasEntries(afterRemoval)) {
        const refreshed = updateFrontmatterDate(afterRemoval, today());
        await writeFile(topicPath, refreshed, "utf8");
      } else {
        await unlink(topicPath).catch(() => {});
      }
    } catch (e: any) {
      // topic file missing — still ok, index already removed
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    return { ok: true };
  });
}
```

**Remove** `doReplace`, `findMatches`, and `MatchSite` entirely.

- [ ] **Step 5: Run tests — verify doAdd and doRemove pass**

```bash
cd pi-memory && npx vitest run tests/memory-tool.test.ts
```

Expected: 13 tests PASS (7 doAdd + 6 doRemove).

- [ ] **Step 6: Typecheck**

```bash
cd pi-memory && npx tsc --noEmit
```

Expected: errors only on `doRead`/`searchMemory`/`execute` — addressed in next tasks.

- [ ] **Step 7: Commit**

```bash
git add pi-memory/src/memory-tool.ts pi-memory/tests/memory-tool.test.ts
git commit -m "refactor(pi-memory): rewrite doAdd (always append) + doRemove (entry exact match), remove doReplace"
```

---

### Task 4: memory-tool.ts — doRead + searchMemory Improvement

**Files:**
- Modify: `pi-memory/src/memory-tool.ts`
- Modify: `pi-memory/tests/memory-tool.test.ts` (append tests)

**Interfaces:**
- Produces: `doRead(memoryDir, params)` where params is `{ topic?: string; entry?: string }`, `searchMemory(memoryDir, query)` returning full entry blocks
- Consumes: `parseEntries` from `topic-file.ts` (Task 1)

---

- [ ] **Step 1: Append tests for doRead and searchMemory**

Append **at the end of the existing test file** `pi-memory/tests/memory-tool.test.ts` (after doRemove describe block):

```ts
import { doRead, searchMemory } from "../src/memory-tool";

describe("doRead", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-read-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("reads entire topic file by topic name (without .md)", async () => {
    await doAdd(dir, {
      content: "staging uses port 2222",
      topic: "debugging.md",
      title: "SSH Gotcha",
      maxLines: 200,
      maxBytes: 25600,
    });
    const res = await doRead(dir, { topic: "debugging" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("## SSH Gotcha");
    expect(res.content).toContain("staging uses port 2222");
    expect(res.content).toContain("updated:");
  });

  it("reads entire topic file by topic name (with .md)", async () => {
    await doAdd(dir, {
      content: "note",
      topic: "misc.md",
      title: "Misc",
      maxLines: 200,
      maxBytes: 25600,
    });
    const res = await doRead(dir, { topic: "misc.md" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("## Misc");
  });

  it("reads single entry block by entry title", async () => {
    await doAdd(dir, {
      content: "first entry content",
      topic: "debugging.md",
      title: "SSH Gotcha",
      maxLines: 200,
      maxBytes: 25600,
    });
    await doAdd(dir, {
      content: "second entry content",
      topic: "debugging.md",
      title: "MySQL Timeout",
      maxLines: 200,
      maxBytes: 25600,
    });
    const res = await doRead(dir, { entry: "MySQL Timeout" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("## MySQL Timeout");
    expect(res.content).toContain("second entry content");
    expect(res.content).not.toContain("first entry content");
  });

  it("errors when topic file not found", async () => {
    const res = await doRead(dir, { topic: "nonexistent" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("errors when entry not found in any topic", async () => {
    const res = await doRead(dir, { entry: "NoSuch" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("rejects path traversal in topic", async () => {
    const res = await doRead(dir, { topic: "../escape" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unsafe|traversal/i);
  });
});

describe("searchMemory", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-search-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("returns the full entry block when query matches", async () => {
    await doAdd(dir, {
      content: "staging uses port 2222\nkey at ~/.ssh/staging",
      topic: "debugging.md",
      title: "SSH Gotcha",
      maxLines: 200,
      maxBytes: 25600,
    });
    await doAdd(dir, {
      content: "connection timeout after 30s",
      topic: "debugging.md",
      title: "MySQL Timeout",
      maxLines: 200,
      maxBytes: 25600,
    });
    const result = await searchMemory(dir, "2222");
    expect(result).toContain("### debugging.md");
    expect(result).toContain("## SSH Gotcha");
    expect(result).toContain("staging uses port 2222");
    expect(result).toContain("~/.ssh/staging");
    // should NOT include the other entry
    expect(result).not.toContain("MySQL Timeout");
  });

  it("returns multiple entries from different topics", async () => {
    await doAdd(dir, {
      content: "port 443 for HTTPS",
      topic: "network.md",
      title: "Firewall Rules",
      maxLines: 200,
      maxBytes: 25600,
    });
    await doAdd(dir, {
      content: "port 2222 for SSH",
      topic: "debugging.md",
      title: "SSH Gotcha",
      maxLines: 200,
      maxBytes: 25600,
    });
    const result = await searchMemory(dir, "port");
    expect(result).toContain("Firewall Rules");
    expect(result).toContain("SSH Gotcha");
  });

  it("returns 'No matches' when nothing found", async () => {
    await doAdd(dir, {
      content: "some note",
      topic: "misc.md",
      title: "Misc",
      maxLines: 200,
      maxBytes: 25600,
    });
    const result = await searchMemory(dir, "nonexistent");
    expect(result).toBe("No matches in memory.");
  });

  it("handles case-insensitive matching", async () => {
    await doAdd(dir, {
      content: "STAGING uses Port 2222",
      topic: "debugging.md",
      title: "SSH",
      maxLines: 200,
      maxBytes: 25600,
    });
    const result = await searchMemory(dir, "staging");
    expect(result).toContain("STAGING uses Port 2222");
  });
});
```

- [ ] **Step 2: Run tests — verify new tests fail**

```bash
cd pi-memory && npx vitest run tests/memory-tool.test.ts
```

Expected: FAIL on doRead/searchMemory tests — functions not exported.

- [ ] **Step 3: Implement doRead**

Add to `pi-memory/src/memory-tool.ts` (after doRemove):

```ts
export interface ReadParams { topic?: string; entry?: string; }
export interface ReadResult { ok: boolean; error?: string; content?: string; }

export async function doRead(memoryDir: string, p: ReadParams): Promise<ReadResult> {
  if (p.topic) {
    const topicName = p.topic.endsWith(".md") ? p.topic : `${p.topic}.md`;
    let topicPath: string;
    try {
      topicPath = safeTopicPath(memoryDir, topicName);
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
    try {
      const content = await readFile(topicPath, "utf8");
      return { ok: true, content };
    } catch {
      return { ok: false, error: `Topic "${p.topic}" not found` };
    }
  }
  if (p.entry) {
    const files = (await readdir(memoryDir).catch(() => [])).filter(
      (f) => f.endsWith(".md") && f !== "MEMORY.md",
    );
    for (const f of files) {
      const raw = await readFile(join(memoryDir, f), "utf8").catch(() => "");
      const entries = parseEntries(raw);
      const found = entries.find((e) => e.title === p.entry);
      if (found) {
        return { ok: true, content: `## ${found.title}\n\n${found.content}` };
      }
    }
    return { ok: false, error: `Entry "${p.entry}" not found in any topic` };
  }
  return { ok: false, error: "Either topic or entry must be provided" };
}:

```ts
export interface ReadParams { topic?: string; entry?: string; }
export interface ReadResult { ok: boolean; error?: string; content?: string; }

export async function doRead(memoryDir: string, p: ReadParams): Promise<ReadResult> {
  if (p.topic) {
    const topicName = p.topic.endsWith(".md") ? p.topic : `${p.topic}.md`;
    let topicPath: string;
    try {
      topicPath = safeTopicPath(memoryDir, topicName);
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
    try {
      const content = await readFile(topicPath, "utf8");
      return { ok: true, content };
    } catch {
      return { ok: false, error: `Topic "${p.topic}" not found` };
    }
  }
  if (p.entry) {
    const files = (await readdir(memoryDir).catch(() => [])).filter(
      (f) => f.endsWith(".md") && f !== "MEMORY.md",
    );
    for (const f of files) {
      const raw = await readFile(join(memoryDir, f), "utf8").catch(() => "");
      const entries = parseEntries(raw);
      const found = entries.find((e) => e.title === p.entry);
      if (found) {
        return { ok: true, content: `## ${found.title}\n\n${found.content}` };
      }
    }
    return { ok: false, error: `Entry "${p.entry}" not found in any topic` };
  }
  return { ok: false, error: "Either topic or entry must be provided" };
}
```

- [ ] **Step 4: Implement improved searchMemory**

Replace the existing `searchMemory` function:

```ts
export async function searchMemory(memoryDir: string, query: string): Promise<string> {
  const files = (await readdir(memoryDir).catch(() => [])).filter(
    (f) => f.endsWith(".md") && f !== "MEMORY.md",
  );
  const q = query.toLowerCase();
  const hits: string[] = [];
  for (const f of files) {
    const raw = await readFile(join(memoryDir, f), "utf8").catch(() => "");
    const entryBlocks = parseEntries(raw);
    for (const entry of entryBlocks) {
      if (entry.content.toLowerCase().includes(q) || entry.title.toLowerCase().includes(q)) {
        hits.push(`### ${f}\n\`\`\`\n## ${entry.title}\n${entry.content}\n\`\`\``);
      }
    }
  }
  return hits.length ? hits.join("\n\n") : "No matches in memory.";
}
```

- [ ] **Step 5: Run all memory-tool tests**

```bash
cd pi-memory && npx vitest run tests/memory-tool.test.ts
```

Expected: all tests PASS (23 total: 7 doAdd + 6 doRemove + 6 doRead + 4 searchMemory).

- [ ] **Step 6: Commit**

```bash
git add pi-memory/src/memory-tool.ts pi-memory/tests/memory-tool.test.ts
git commit -m "feat(pi-memory): add doRead (topic/entry) + improved searchMemory (full entry blocks)"
```

---

### Task 5: memory-tool.ts — Execute Routing + Type Cleanup + Schema

**Files:**
- Modify: `pi-memory/src/memory-tool.ts`

**Interfaces:**
- Changes: `execute` routing to handle `add`/`remove`/`search`/`read` (no `replace`)
- Updates: `promptSnippet`, `promptGuidelines`, `parameters` schema

---

- [ ] **Step 1: Update prompt metadata and schema**

In `createMemoryTool`, update `description`, `promptSnippet`, `promptGuidelines`, and `parameters`:

```ts
description:
  "Read/write project memory across sessions. action 'add' appends content under a topic (auto-created) as an entry; 'remove' deletes an entry by title; 'read' loads a topic or entry; 'search' queries memory files or history sessions.",
promptSnippet: "Read/write project memory across sessions (add/remove/search/read).",
promptGuidelines: [
  "Use memory to persist project facts, user preferences, and lessons learned across sessions.",
  "Use memory action 'add' with an explicit topic filename and entry title when you discover something worth remembering long-term.",
  "Use memory action 'search' with scope='sessions' to find past work in history sessions.",
  "Use memory action 'read' with topic or entry to load stored knowledge.",
],
parameters: Type.Object({
  action: StringEnum(["add", "remove", "search", "read"] as const),
  // add
  content: Type.Optional(Type.String({ description: "Knowledge text to store (add)." })),
  topic: Type.Optional(Type.String({ description: "Target topic filename, e.g. 'debugging.md'. Auto-created if new (add/read)." })),
  title: Type.Optional(Type.String({ description: "Short title for the MEMORY.md index line (add). Required for add." })),
  // remove
  entry: Type.Optional(Type.String({ description: "Entry title to remove. Exact match on MEMORY.md index line (remove/read)." })),
  // search
  query: Type.Optional(Type.String()),
  scope: Type.Optional(StringEnum(["memory", "sessions"] as const)),
}),
```

- [ ] **Step 2: Rewrite execute routing**

Replace the `execute` function body:

```ts
async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, _ctx: any) {
  if (!deps.getEnabled()) throw new Error("Memory is disabled (run /memory on)");
  const dir = deps.getMemoryDir();
  const cfg = deps.getConfig();
  if (!dir) throw new Error("Memory not initialized (no session_start yet)");
  let text: string;
  let details: any = {};
  switch (params.action) {
    case "add": {
      if (!params.content) throw new Error("content is required for add");
      if (!params.topic) throw new Error("topic is required for add");
      if (!params.title) throw new Error("title is required for add");
      const r = await doAdd(dir, {
        content: params.content,
        topic: params.topic,
        title: params.title,
        maxLines: cfg.memIndexMaxLines,
        maxBytes: cfg.memIndexMaxBytes,
      });
      if (!r.ok) throw new Error(r.error);
      text = `Added "${params.title}" to ${params.topic}. Index now has ${r.entries?.length ?? 0} entries.`;
      details = { entries: r.entries?.length };
      break;
    }
    case "remove": {
      if (!params.entry) throw new Error("entry is required for remove");
      const r = await doRemove(dir, { entry: params.entry });
      if (!r.ok) throw new Error(r.error);
      text = `Removed entry "${params.entry}".`;
      break;
    }
    case "search": {
      if (!params.query) throw new Error("query is required for search");
      if (params.scope === "sessions") {
        text = await deps.searchSessions(deps.cwd(), params.query, cfg.sessionSearch);
      } else {
        text = await searchMemory(dir, params.query);
      }
      break;
    }
    case "read": {
      if (!params.topic && !params.entry) throw new Error("topic or entry is required for read");
      const r = await doRead(dir, { topic: params.topic, entry: params.entry });
      if (!r.ok) throw new Error(r.error);
      text = r.content!;
      break;
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
  return { content: [{ type: "text", text }], details };
},
```

- [ ] **Step 3: Verify build**

```bash
cd pi-memory && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
cd pi-memory && npx vitest run
```

Expected: all existing tests pass (topic-file 14, index-file 16, memory-tool 23, plus all other suites).

- [ ] **Step 5: Commit**

```bash
git add pi-memory/src/memory-tool.ts
git commit -m "refactor(pi-memory): update execute routing + schema for v2 API (remove replace, add read)"
```

---

### Task 6: index.ts + dream.ts — API Registration + Dream Prompt

**Files:**
- Modify: `pi-memory/index.ts`
- Modify: `pi-memory/src/dream.ts`
- Modify: `pi-memory/tests/dream.test.ts`

**Interfaces:**
- Consumes: `createMemoryTool` from Task 5
- Changes: dream prompt for entry-level consolidation

---

- [ ] **Step 1: Update dream prompt**

In `pi-memory/src/dream.ts`, replace `DREAM_SYSTEM_PROMPT` and `buildDreamTask`:

```ts
export const DREAM_SYSTEM_PROMPT = `You are a memory consolidation agent. Your job: read all memory files in the given directory, consolidate entries within each topic (merge duplicates, resolve contradictions, update outdated info), and rebuild the MEMORY.md index to be concise and accurate.
Rules:
- Each topic file contains entries as \`## Entry Title\` blocks.
- Only modify files under the given directory. Never touch anything else.
- Deduplicate entries: if two entries in the same topic contain the same info, merge them.
- If entries across different topics overlap, move the content to the more appropriate topic.
- Rebuild MEMORY.md index: list entries you deem valuable (not necessarily every entry). Each line: - [Entry Title](topic.md). Accuracy matters more than completeness.
- When done, output a concise summary of changes (merged N, removed N, moved N, updated N).`;

export function buildDreamTask(memoryDir: string, maxLines: number): string {
  return `Consolidate the memory files under ${memoryDir}. Read every .md file (including MEMORY.md), then:
1. Deduplicate entries within each topic that say the same thing.
2. Merge contradictory or overlapping entries into one accurate entry.
3. Update outdated information.
4. Move entries to more appropriate topic files when needed.
5. Rebuild MEMORY.md (max ${maxLines} lines): - [Entry Title](topic.md) per entry you deem valuable.
Only edit files under ${memoryDir}. When finished, print a one-line summary of changes.`;
}
```

- [ ] **Step 2: Update dream test**

In `pi-memory/tests/dream.test.ts`, update the `buildDreamTask` test:

```ts
describe("buildDreamTask", () => {
  it("includes memory dir + entry-level consolidation instructions + line limit", () => {
    const task = buildDreamTask("/mem/abc123", 200);
    expect(task).toContain("/mem/abc123");
    expect(task).toMatch(/deduplicat|consolidat/i);
    expect(task).toContain("200");
    expect(task).toContain("## Entry Title");
    expect(task).toContain("not necessarily every entry");
  });
});
```

- [ ] **Step 3: Remove obsolete inject.ts import (if needed)**

Check if `pi-memory/src/inject.ts` imports anything from `index-file.ts` that changed. Read it:

```bash
cd pi-memory && grep -n "from.*index-file" src/inject.ts
```

If it imports `parseIndex`, that's fine — it still exists. No changes needed to inject.ts.

- [ ] **Step 4: Run dream tests**

```bash
cd pi-memory && npx vitest run tests/dream.test.ts
```

Expected: all dream tests PASS.

- [ ] **Step 5: Full typecheck**

```bash
cd pi-memory && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run full test suite**

```bash
cd pi-memory && npx vitest run
```

Expected: all tests PASS across all suites.

- [ ] **Step 7: Commit**

```bash
git add pi-memory/src/dream.ts pi-memory/tests/dream.test.ts
git commit -m "refactor(pi-memory): update dream prompt for entry-level consolidation"
```

---

### Task 7: Bump version + Final Verification

**Files:**
- Modify: `pi-memory/package.json`

- [ ] **Step 1: Bump version to 0.2.0**

```bash
cd pi-memory && npm version 0.2.0 --no-git-tag-version
```

- [ ] **Step 2: Run full monorepo test suite**

```bash
cd ../.. && npm test
```

Expected: all tests PASS across all packages.

- [ ] **Step 3: Commit version bump**

```bash
git add pi-memory/package.json
git commit -m "chore(pi-memory): bump version to 0.2.0"
```

