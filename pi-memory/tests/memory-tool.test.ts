import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { doAdd, doRemove, doRead, searchMemory } from "../src/memory-tool";

describe("doAdd", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-add-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("creates a new topic file with full frontmatter + MEMORY.md entry (one per topic)", async () => {
    const res = await doAdd(dir, {
      content: "staging uses port 2222",
      topic: "debugging.md",
      title: "SSH Gotcha",
      maxLines: 200,
      maxBytes: 25600,
    });
    expect(res.ok).toBe(true);
    // One index entry per topic: - [debugging](debugging.md) — SSH Gotcha
    const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(mem).toContain("[debugging](debugging.md)");
    expect(mem).toContain("SSH Gotcha");
    expect(mem).toContain(" — ");
    // Topic file has full frontmatter
    const topic = await readFile(join(dir, "debugging.md"), "utf8");
    expect(topic).toContain("staging uses port 2222");
    expect(topic).toContain("updated:");
    expect(topic).toContain("name: debugging");
    expect(topic).toContain("description: SSH Gotcha");
    expect(topic).toContain("type: feedback");
    expect(topic).toContain("## SSH Gotcha");
    // No level-1 heading
    expect(topic).not.toMatch(/^# SSH Gotcha/m);
  });

  it("appends second entry to same topic (one index line, hook updated)", async () => {
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
    // Only one index line for the topic, hook updated to latest entry title
    const lines = mem.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(mem).toContain("[debugging](debugging.md)");
    expect(mem).toContain("MySQL Timeout");
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

  it("updates description on append to existing topic to match hook", async () => {
    await doAdd(dir, {
      content: "first note",
      topic: "misc.md",
      title: "Entry One",
      maxLines: 200,
      maxBytes: 25600,
    });
    await doAdd(dir, {
      content: "second note",
      topic: "misc.md",
      title: "Entry Two plus more",
      maxLines: 200,
      maxBytes: 25600,
    });
    const topic = await readFile(join(dir, "misc.md"), "utf8");
    // description should be regenerated from all entry titles
    expect(topic).toContain("description: Entry One; Entry Two plus more");
    // MEMORY.md hook should match description
    const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(mem).toContain("Entry One; Entry Two plus more");
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

  it("accepts explicit type parameter", async () => {
    const res = await doAdd(dir, {
      content: "user preference",
      topic: "prefs.md",
      title: "Editor",
      type: "user",
      maxLines: 200,
      maxBytes: 25600,
    });
    expect(res.ok).toBe(true);
    const topic = await readFile(join(dir, "prefs.md"), "utf8");
    expect(topic).toContain("type: user");
  });

  it("rejects invalid type", async () => {
    const res = await doAdd(dir, {
      content: "x",
      topic: "a.md",
      title: "A",
      type: "invalid",
      maxLines: 200,
      maxBytes: 25600,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid type");
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
    expect(mem).toContain("[ssh](ssh.md)");
    expect(mem).toContain("[firewall](firewall.md)");
  });
});

describe("doRemove", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-rm-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("removes entry by title: deletes ## block and updates hook", async () => {
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
    // Index still has one entry for debugging.md, hook updated to remaining entry
    const lines = mem.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(mem).toContain("[debugging](debugging.md)");
    expect(mem).toContain("MySQL Timeout");
    const topic = await readFile(join(dir, "debugging.md"), "utf8");
    // Entry block is gone (but frontmatter description may still reference it)
    expect(topic).not.toContain("## SSH Gotcha");
    expect(topic).not.toContain("staging uses port 2222");
    expect(topic).toContain("## MySQL Timeout");
    expect(topic).toContain("connection timeout after 30s");
  });

  it("deletes topic file and index entry when last entry removed", async () => {
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
    expect(mem.trim()).toBe("");
  });

  it("errors when entry not found", async () => {
    const res = await doRemove(dir, { entry: "NoSuch" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });

  it("errors on multiple matches across different topics", async () => {
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

  it("updates description after removing one entry from multi-entry topic", async () => {
    await doAdd(dir, {
      content: "first",
      topic: "misc.md",
      title: "Entry Alpha",
      maxLines: 200,
      maxBytes: 25600,
    });
    await doAdd(dir, {
      content: "second",
      topic: "misc.md",
      title: "Entry Beta",
      maxLines: 200,
      maxBytes: 25600,
    });
    await doRemove(dir, { entry: "Entry Alpha" });
    const topic = await readFile(join(dir, "misc.md"), "utf8");
    expect(topic).toContain("description: Entry Beta");
    const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(mem).toContain("Entry Beta");
  });
});

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
    // Full frontmatter present
    expect(res.content).toContain("name: debugging");
    expect(res.content).toContain("description:");
    expect(res.content).toContain("type:");
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
