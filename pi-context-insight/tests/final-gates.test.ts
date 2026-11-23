import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInsight } from "../src/command";
import { chattySession } from "./helpers/sessions";

describe("release gates", () => {
	it("short mode leaks no sentinel text through any channel", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-insight-short-"));
		try {
			await runInsight("s.html --short", chattySession(root));
			const html = readFileSync(join(root, "s.html"), "utf8");
			for (const sentinel of [
				"prompt-sentinel",
				"answer-sentinel",
				"thinking-sentinel",
				"tool-output-sentinel",
				"command-sentinel",
				"output-sentinel",
				"brief-sentinel",
				"result-sentinel",
				"description-sentinel",
				"summary-sentinel",
				"injected-sentinel",
				"todo-sentinel",
				"compaction-sentinel",
			]) {
				expect(html, sentinel).not.toContain(sentinel);
			}
			expect(html).not.toContain("</script><script>");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("full mode keeps the same content and never emits NaN", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-insight-full-"));
		try {
			await runInsight("f.html", chattySession(root));
			const html = readFileSync(join(root, "f.html"), "utf8");
			for (const sentinel of ["prompt-sentinel", "tool-output-sentinel", "command-sentinel", "answer-sentinel"]) {
				expect(html).toContain(sentinel);
			}
			expect(html).toContain("data-banner=\"raw-content\"");
			expect(html).not.toMatch(/NaN/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
