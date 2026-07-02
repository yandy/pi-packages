import { describe, it, expect } from "vitest";
import { parseIndex, serializeIndex, upsertEntry, truncateForInjection, checkCapacity, type IndexEntry } from "../src/index-file";

// Note: the dashes below are U+2014 EM DASH, not two hyphens
const SAMPLE = `- [Go API Setup](architecture.md) — Go 1.22, sqlc, chi, Postgres 16 at ~/code/api
- [Build Commands](builds.md) — make test, make lint, make build for linux/amd64
- [SSH Gotcha](debugging.md) — staging server uses port 2222, key at ~/.ssh/staging_ed25519`;

describe("parseIndex", () => {
	it("parses pointer lines into entries", () => {
		const f = parseIndex(SAMPLE);
		expect(f.entries).toHaveLength(3);
		expect(f.entries[0]).toMatchObject({ title: "Go API Setup", topic: "architecture.md", description: "Go 1.22, sqlc, chi, Postgres 16 at ~/code/api" });
	});
	it("ignores blank lines and non-pointer lines", () => {
		const f = parseIndex(`# Memory\n\n${SAMPLE}\n\nsome note`);
		expect(f.entries).toHaveLength(3);
	});
});

describe("serializeIndex", () => {
	it("round-trips entries", () => {
		const f = parseIndex(SAMPLE);
		expect(serializeIndex(f.entries)).toBe(SAMPLE);
	});
});

describe("upsertEntry", () => {
	it("adds a new entry by topic", () => {
		const f = parseIndex(SAMPLE);
		const next = upsertEntry(f.entries, { title: "User Style", topic: "user.md", description: "concise replies", raw: "" });
		expect(next).toHaveLength(4);
		expect(next[3].topic).toBe("user.md");
	});
	it("updates existing entry by topic", () => {
		const f = parseIndex(SAMPLE);
		const next = upsertEntry(f.entries, { title: "Builds", topic: "builds.md", description: "updated desc", raw: "" });
		expect(next).toHaveLength(3);
		expect(next.find((e) => e.topic === "builds.md")?.description).toBe("updated desc");
	});
});

describe("truncateForInjection", () => {
	it("keeps content under limits", () => {
		const r = truncateForInjection(SAMPLE, 200, 25600);
		expect(r.ok).toBe(true);
		expect(r.truncated).toBe(false);
		expect(r.content).toBe(SAMPLE);
	});
	it("truncates by line count", () => {
		const many = Array.from({ length: 10 }, (_, i) => `- [T${i}](t${i}.md) — d${i}`).join("\n");
		const r = truncateForInjection(many, 3, 25600);
		expect(r.truncated).toBe(true);
		expect(r.content.split("\n").length).toBe(4);
		expect(r.content).toContain("[truncated:");
	});
});

it("truncates by byte count when under line limit", () => {
	const longLine = `- [A very long title that exceeds the byte limit](example.md) — some description here`;
	const r = truncateForInjection(longLine, 100, 50);
	expect(r.truncated).toBe(true);
	// content before the truncated marker should be ≤ maxBytes
	const beforeMarker = r.content.split("\n")[0];
	expect(Buffer.byteLength(beforeMarker, "utf8")).toBeLessThanOrEqual(50);
	expect(r.content).toContain("[truncated:");
});

describe("checkCapacity", () => {
	it("returns true under limits", () => {
		const f = parseIndex(SAMPLE);
		expect(checkCapacity(f.entries, 200, 25600)).toBe(true);
	});
	it("returns false when over line limit", () => {
		const many: IndexEntry[] = Array.from({ length: 201 }, (_, i) => ({ title: `T${i}`, topic: `t${i}.md`, description: "d", raw: "" }));
		expect(checkCapacity(many, 200, 25600)).toBe(false);
	});
});
