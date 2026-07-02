import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadIndexSnapshot, buildInjection } from "../src/inject";

describe("loadIndexSnapshot", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-inj-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("returns empty string when MEMORY.md missing", async () => {
		expect(await loadIndexSnapshot(dir, 200, 25600)).toBe("");
	});
	it("returns truncated content when MEMORY.md exists", async () => {
		const content = "- [A](a.md) — desc a\n- [B](b.md) — desc b";
		await writeFile(join(dir, "MEMORY.md"), content);
		const snap = await loadIndexSnapshot(dir, 200, 25600);
		expect(snap).toContain("# Memory Index");
		expect(snap).toContain("- [A](a.md)");
	});
	it("truncates to limits", async () => {
		const many = Array.from({ length: 10 }, (_, i) => `- [T${i}](t${i}.md) — d${i}`).join("\n");
		await writeFile(join(dir, "MEMORY.md"), many);
		const snap = await loadIndexSnapshot(dir, 3, 25600);
		expect(snap).toContain("[truncated:");
	});
});

describe("buildInjection", () => {
	it("appends snapshot to system prompt", () => {
		const out = buildInjection("BASE PROMPT", "# Memory Index\n- [A](a.md) — desc");
		expect(out).toBe("BASE PROMPT\n\n# Memory Index\n- [A](a.md) — desc");
	});
	it("returns base unchanged when snapshot is empty", () => {
		expect(buildInjection("BASE", "")).toBe("BASE");
	});
});
