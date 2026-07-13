import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	SessionManager: {
		list: async (cwd: string) => {
			const fs = await import("node:fs/promises");
			const path = await import("node:path");
			try {
				return (await fs.readdir(join(cwd, "__sessions__"))).map((f) => ({ path: f }));
			} catch {
				return [];
			}
		},
	},
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => "/tmp/agent",
}));

import { readDreamMeta, shouldNudge, formatNudge } from "../src/nudge";

describe("formatNudge", () => {
	it("formats session + new-entry counts", () => {
		expect(formatNudge(8, 3)).toContain("8 sessions");
		expect(formatNudge(8, 3)).toContain("3 new entries");
		expect(formatNudge(8, 3)).toContain("/dream");
	});
});

describe("readDreamMeta", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-nudge-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("returns null when no meta file", async () => {
		expect(await readDreamMeta(dir)).toBeNull();
	});
	it("reads meta json", async () => {
		await writeFile(join(dir, ".dream-meta.json"), JSON.stringify({ lastDreamAt: "2026-07-01T00:00:00.000Z", sessionCountAtDream: 3 }));
		const m = await readDreamMeta(dir);
		expect(m?.lastDreamAt).toBe("2026-07-01T00:00:00.000Z");
		expect(m?.sessionCountAtDream).toBe(3);
	});
});

describe("shouldNudge", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-nudge-"));
		await mkdir(join(dir, "__sessions__"), { recursive: true });
	});
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("nudges when enough sessions passed since last dream", async () => {
		await writeFile(join(dir, ".dream-meta.json"), JSON.stringify({ lastDreamAt: new Date(Date.now() - 48 * 3600_000).toISOString(), sessionCountAtDream: 2 }));
		// create 8 fake session files
		for (let i = 0; i < 8; i++) await writeFile(join(dir, "__sessions__", `s${i}.jsonl`), "{}");
		const r = await shouldNudge(dir, { dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, model: "auto" } } as any, dir);
		expect(r.nudge).toBe(true);
		expect(r.sessions).toBe(8);
		expect(r.newEntries).toBe(6); // 8 sessions - 2 at last dream
	});
	it("does not nudge when recent dream", async () => {
		await writeFile(join(dir, ".dream-meta.json"), JSON.stringify({ lastDreamAt: new Date().toISOString(), sessionCountAtDream: 0 }));
		const r = await shouldNudge(dir, { dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, model: "auto" } } as any, dir);
		expect(r.nudge).toBe(false);
		expect(r.sessions).toBeGreaterThanOrEqual(0);
		expect(r.newEntries).toBeGreaterThanOrEqual(0);
	});
});
