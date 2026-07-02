import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { doAdd, doReplace, doRemove } from "../src/memory-tool";

describe("doAdd", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-add-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("creates a new topic file + MEMORY.md entry", async () => {
		const res = await doAdd(dir, { content: "staging uses port 2222", topic: "debugging.md", title: "SSH Gotcha", description: "staging port", maxLines: 200, maxBytes: 25600 });
		expect(res.ok).toBe(true);
		const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
		expect(mem).toContain("[SSH Gotcha](debugging.md)");
		expect(mem).toContain("staging port");
		const topic = await readFile(join(dir, "debugging.md"), "utf8");
		expect(topic).toContain("staging uses port 2222");
		expect(topic).toContain("name:"); // frontmatter
	});
	it("appends to existing topic file + updates index line", async () => {
		await doAdd(dir, { content: "first note", topic: "debugging.md", title: "Debug", description: "d1", maxLines: 200, maxBytes: 25600 });
		const res = await doAdd(dir, { content: "second note", topic: "debugging.md", title: "Debug", description: "d2", maxLines: 200, maxBytes: 25600 });
		expect(res.ok).toBe(true);
		const topic = await readFile(join(dir, "debugging.md"), "utf8");
		expect(topic).toContain("first note");
		expect(topic).toContain("second note");
		const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
		expect(mem).toContain("d2"); // description updated, not duplicated
		expect(mem.match(/\(debugging\.md\)/g)).toHaveLength(1);
	});
	it("rejects when over capacity and returns current entries", async () => {
		const res = await doAdd(dir, { content: "x", topic: "a.md", title: "A", description: "d", maxLines: 0, maxBytes: 25600 });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("capacity");
	});
	it("rejects path traversal topic", async () => {
		const res = await doAdd(dir, { content: "x", topic: "../escape.md", title: "A", description: "d", maxLines: 200, maxBytes: 25600 });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/unsafe|traversal|escape/i);
	});
});

describe("doReplace", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-rep-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("replaces a substring in a topic file", async () => {
		await doAdd(dir, { content: "staging uses port 2222", topic: "debugging.md", title: "SSH", description: "d", maxLines: 200, maxBytes: 25600 });
		const res = await doReplace(dir, { old_text: "2222", content: "2223", topic: "debugging.md" });
		expect(res.ok).toBe(true);
		const topic = await readFile(join(dir, "debugging.md"), "utf8");
		expect(topic).toContain("2223");
		expect(topic).not.toContain("2222");
	});
	it("errors on zero matches", async () => {
		const res = await doReplace(dir, { old_text: "nonexistent", content: "x" });
		expect(res.ok).toBe(false);
	});
	it("errors on multiple matches without topic", async () => {
		await doAdd(dir, { content: "dup token", topic: "a.md", title: "A", description: "d", maxLines: 200, maxBytes: 25600 });
		await doAdd(dir, { content: "dup token", topic: "b.md", title: "B", description: "d", maxLines: 200, maxBytes: 25600 });
		const res = await doReplace(dir, { old_text: "dup token", content: "new" });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/multiple|ambiguous/i);
	});
});

describe("doRemove", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-rm-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("removes a matching index line", async () => {
		await doAdd(dir, { content: "x", topic: "a.md", title: "A", description: "da", maxLines: 200, maxBytes: 25600 });
		await doAdd(dir, { content: "y", topic: "b.md", title: "B", description: "db", maxLines: 200, maxBytes: 25600 });
		const res = await doRemove(dir, { old_text: "db" });
		expect(res.ok).toBe(true);
		const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
		expect(mem).not.toContain("[B]");
		expect(mem).toContain("[A]");
	});
});
