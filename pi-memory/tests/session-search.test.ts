import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock SessionManager.list to return our fixture session files under a fake cwd-hash dir.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		SessionManager: {
			...actual.SessionManager,
			list: async (cwd: string) => {
				const fs = await import("node:fs/promises");
				const path = await import("node:path");
				// fixture dir convention: <cwd>/__sessions__/*.jsonl
				const dir = join(cwd, "__sessions__");
				try {
					const files = await fs.readdir(dir);
					return files.filter((f) => f.endsWith(".jsonl")).map((f) => ({
						path: join(dir, f), id: f, cwd, created: new Date(), modified: new Date(),
						messageCount: 1, firstMessage: "", allMessagesText: "",
					}));
				} catch {
					return [];
				}
			},
		},
	};
});

import { searchSessions } from "../src/session-search";

function jsonlLine(obj: any): string {
	return JSON.stringify({ id: "abc12345", parentId: null, timestamp: new Date().toISOString(), ...obj });
}

describe("searchSessions", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-sess-"));
		await mkdir(join(dir, "__sessions__"), { recursive: true });
	});
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("finds matches in session JSONL message entries", async () => {
		const line = jsonlLine({ type: "message", message: { role: "user", content: "fix the deadlock in payment", timestamp: Date.now() } });
		await writeFile(join(dir, "__sessions__", "s1.jsonl"), `{"type":"session","version":3,"id":"x","timestamp":"2026-06-28T00:00:00.000Z","cwd":"${dir}"}\n${line}\n`);
		const res = await searchSessions(dir, "deadlock", { maxSessions: 10, maxMatches: 5 });
		expect(res).toContain("deadlock");
		expect(res).toContain("s1.jsonl");
	});
	it("returns no-matches message when nothing found", async () => {
		const line = jsonlLine({ type: "message", message: { role: "user", content: "hello world", timestamp: Date.now() } });
		await writeFile(join(dir, "__sessions__", "s1.jsonl"), `{"type":"session","version":3,"id":"x","timestamp":"2026-06-28T00:00:00.000Z","cwd":"${dir}"}\n${line}\n`);
		const res = await searchSessions(dir, "deadlock", { maxSessions: 10, maxMatches: 5 });
		expect(res).toMatch(/no match/i);
	});
	it("skips non-message entries (headers, custom)", async () => {
		const custom = jsonlLine({ type: "custom", customType: "x", data: { note: "deadlock noise" } });
		await writeFile(join(dir, "__sessions__", "s1.jsonl"), `{"type":"session","version":3,"id":"x","timestamp":"2026-06-28T00:00:00.000Z","cwd":"${dir}"}\n${custom}\n`);
		const res = await searchSessions(dir, "deadlock", { maxSessions: 10, maxMatches: 5 });
		expect(res).toMatch(/no match/i);
	});
});
