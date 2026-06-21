import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/write-file-atomic";

describe("writeFileAtomic", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-coding-tools-atomic-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes content to a new file", async () => {
		const filePath = join(tempDir, "output.txt");
		await writeFileAtomic(filePath, "hello world");
		expect(readFileSync(filePath, "utf-8")).toBe("hello world");
	});

	it("overwrites an existing file", async () => {
		const filePath = join(tempDir, "existing.txt");
		writeFileSync(filePath, "old content");
		await writeFileAtomic(filePath, "new content");
		expect(readFileSync(filePath, "utf-8")).toBe("new content");
	});

	it("does not leave temp files on success", async () => {
		const filePath = join(tempDir, "clean.txt");
		await writeFileAtomic(filePath, "data");
		const files = require("node:fs").readdirSync(tempDir);
		expect(files).toEqual(["clean.txt"]);
	});

	it("uses utf-8 encoding", async () => {
		const filePath = join(tempDir, "utf8.txt");
		await writeFileAtomic(filePath, "héllo wörld");
		expect(readFileSync(filePath, "utf-8")).toBe("héllo wörld");
	});
});
