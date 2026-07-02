import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadIndexSnapshot, buildInjection } from "../src/inject";

// Verify the snapshot value is frozen: loading once, then writing a new MEMORY.md,
// the previously-loaded snapshot must NOT change (snapshot semantics).
describe("snapshot is frozen", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-snap-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("does not reflect mid-session MEMORY.md writes", async () => {
		await writeFile(join(dir, "MEMORY.md"), "- [A](a.md) — desc a");
		const snapshot = await loadIndexSnapshot(dir, 200, 25600);
		// simulate a mid-session memory add writing a new entry
		await writeFile(join(dir, "MEMORY.md"), "- [A](a.md) — desc a\n- [B](b.md) — desc b");
		// the injected prompt built from the FROZEN snapshot must still show only A
		const injected = buildInjection("BASE", snapshot);
		expect(injected).toContain("- [A](a.md)");
		expect(injected).not.toContain("- [B](b.md)");
	});
});
