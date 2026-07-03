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
    expect(topic).not.toMatch(/^# SSH Gotcha/m);
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
