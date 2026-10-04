import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReservedNameFixture, removeReservedNameFixture } from "./reserved-name";

describe("reserved-name fixture helper", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-rn-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("creates and removes a reserved-name file via the platform-appropriate path", async () => {
		// 只用 readdir 验证：win32 上普通路径 open con.md 会命中 CON 设备，绝不能读内容
		await createReservedNameFixture(dir, "con.md", "正文");
		expect(await readdir(dir)).toContain("con.md");

		await removeReservedNameFixture(dir, "con.md");
		expect(await readdir(dir)).not.toContain("con.md");
	});
});
