import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSnapshot, pruneSnapshots } from "../src/snapshot";

let memoryDir: string;
let backupRoot: string;

const at = (iso: string) => () => new Date(iso);

beforeEach(async () => {
	memoryDir = await mkdtemp(join(tmpdir(), "mem-snapshot-"));
	backupRoot = join(memoryDir, ".backups");
	await writeFile(join(memoryDir, "MEMORY.md"), "# Memory Index\n", "utf8");
});
afterEach(async () => {
	await rm(memoryDir, { recursive: true, force: true });
});

describe("createSnapshot", () => {
	it("copies the listed files into a timestamped directory", async () => {
		await writeFile(join(memoryDir, "a.md"), "A\n", "utf8");
		const dir = await createSnapshot(backupRoot, "write", ["MEMORY.md", "a.md"], memoryDir, {
			keep: 5,
			now: at("2026-10-01T00:00:01.000Z"),
		});
		expect(dir).toBe(join(backupRoot, "2026-10-01T00-00-01-000Z-write"));
		expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("# Memory Index\n");
		expect(await readFile(join(dir, "a.md"), "utf8")).toBe("A\n");
	});

	it("skips files that do not exist yet", async () => {
		const dir = await createSnapshot(backupRoot, "write", ["MEMORY.md", "missing.md"], memoryDir, {
			keep: 5,
			now: at("2026-10-01T00:00:01.000Z"),
		});
		expect(await readdir(dir)).toEqual(["MEMORY.md"]);
	});

	it("does not collide when two snapshots share a timestamp", async () => {
		const now = at("2026-10-01T00:00:02.000Z");
		const first = await createSnapshot(backupRoot, "write", ["MEMORY.md"], memoryDir, { keep: 5, now });
		const second = await createSnapshot(backupRoot, "write", ["MEMORY.md"], memoryDir, { keep: 5, now });
		expect(second).toBe(`${first}-2`);
	});

	it("keeps only the newest snapshots", async () => {
		for (let i = 1; i <= 7; i++) {
			await createSnapshot(backupRoot, "write", ["MEMORY.md"], memoryDir, {
				keep: 5,
				now: at(`2026-10-01T00:00:0${i}.000Z`),
			});
		}
		const names = (await readdir(backupRoot)).sort();
		expect(names).toHaveLength(5);
		expect(names[0]).toBe("2026-10-01T00-00-03-000Z-write");
		expect(names[4]).toBe("2026-10-01T00-00-07-000Z-write");
	});

	it("never prunes migration snapshots", async () => {
		await mkdir(join(backupRoot, "migrate-2026-09-01T00-00-00-000Z"), { recursive: true });
		for (let i = 1; i <= 7; i++) {
			await createSnapshot(backupRoot, "write", ["MEMORY.md"], memoryDir, {
				keep: 5,
				now: at(`2026-10-01T00:00:0${i}.000Z`),
			});
		}
		const names = await readdir(backupRoot);
		expect(names).toContain("migrate-2026-09-01T00-00-00-000Z");
		expect(names.filter((n) => n.endsWith("-write"))).toHaveLength(5);
	});

	it("fails closed when the backup root cannot be created", async () => {
		const asFile = join(memoryDir, "not-a-dir");
		await writeFile(asFile, "x", "utf8");
		await expect(
			createSnapshot(asFile, "write", [], memoryDir, { keep: 5, now: at("2026-10-01T00:00:01.000Z") }),
		).rejects.toThrow();
	});
});

describe("pruneSnapshots", () => {
	it("is a no-op for a missing backup root", async () => {
		await expect(pruneSnapshots(join(memoryDir, "nope"), 5)).resolves.toBeUndefined();
	});
});
