import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectDirName, projectIdentity } from "@yandy0725/auto-memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectLegacyMemoryDir } from "../src/legacy-hint";

/**
 * 2.x → 3.0 的数据根迁移提示（spec D3 / D4）。
 *
 * 两条硬约束：
 * - **只提示、不动数据**：探测过程不得创建、修改或删除任何文件（用户可能只是想看看状态）；
 * - **不迁移完就不再唠叨**：新根已存在时返回 null。
 *
 * 提示逻辑住在 pi 适配层而不是 core —— core 对 `.pi` 一无所知。
 */
let base: string;
let cwd: string;
let legacyRoot: string;
let newRoot: string;
let newDir: string;
let legacyDir: string;

/** 与实现同一条路径推导：非 git 目录 → `local/<绝对路径>`。 */
async function resolvedProjectSubpath(dir: string): Promise<string> {
	const { kind, key } = await projectIdentity(dir);
	return join(kind, projectDirName(key));
}

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "mem-legacy-"));
	cwd = join(base, "proj");
	await mkdir(cwd, { recursive: true });
	legacyRoot = join(base, ".pi", "memory");
	newRoot = join(base, ".local", "share", "auto-memory");
	const sub = await resolvedProjectSubpath(cwd);
	legacyDir = join(legacyRoot, sub);
	newDir = join(newRoot, sub);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

const opts = () => ({ newDir, newRoot, legacyRoot, cwd });

/**
 * 递归列出 base 下的全部条目：相对路径 + 类型 + `mtimeMs` + 大小。
 * 带上 mtime 与大小，才能同时抓到「新建/删除条目」与「原地改写内容」两类写盘。
 */
async function snapshotTree(root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			const st = await stat(full);
			out.push(`${full.slice(root.length)} ${entry.isDirectory() ? "dir" : "file"} ${st.mtimeMs} ${st.size}`);
			if (entry.isDirectory()) await walk(full);
		}
	};
	await walk(root);
	return out.sort();
}

describe("detectLegacyMemoryDir", () => {
	it("returns the hint when the new dir is missing and the legacy one exists", async () => {
		await mkdir(legacyDir, { recursive: true });
		await writeFile(join(legacyDir, "MEMORY.md"), "# Memory Index\n", "utf8");

		const hint = await detectLegacyMemoryDir(opts());

		expect(hint).toContain(legacyDir);
		expect(hint).toContain("pre-3.0");
	});

	it("renders the mv command with the real roots, not placeholders", async () => {
		await mkdir(legacyDir, { recursive: true });

		const hint = await detectLegacyMemoryDir(opts());

		expect(hint).toContain(`mkdir -p ${dirname(newRoot)}`);
		expect(hint).toContain(`mv ${legacyRoot} ${newRoot}`);
	});

	// Review Focus #2：迁移完成后每次 /memory 都唠叨一遍是噪音。
	it("returns null once the new dir exists", async () => {
		await mkdir(legacyDir, { recursive: true });
		await mkdir(newDir, { recursive: true });

		expect(await detectLegacyMemoryDir(opts())).toBeNull();
	});

	it("returns null when neither dir exists", async () => {
		expect(await detectLegacyMemoryDir(opts())).toBeNull();
	});

	it("returns null when only the new dir exists", async () => {
		await mkdir(newDir, { recursive: true });
		expect(await detectLegacyMemoryDir(opts())).toBeNull();
	});

	it("returns null when the legacy root exists but not this project's subdir", async () => {
		await mkdir(join(legacyRoot, "local", "some__other__project"), { recursive: true });
		expect(await detectLegacyMemoryDir(opts())).toBeNull();
	});

	// 用户配了自定义 memoryDir 时，命令必须搬去**它真正会读**的地方，而不是 XDG 默认根：
	// 否则用户照着我们打印的命令搬完，agent 仍然看着空目录，而这条提示是他唯一的线索。
	it("aims the mv at the configured root, not the XDG default", async () => {
		await mkdir(legacyDir, { recursive: true });
		const customRoot = join(base, "somewhere-else");
		const customDir = join(customRoot, await resolvedProjectSubpath(cwd));

		const hint = await detectLegacyMemoryDir({ newDir: customDir, newRoot: customRoot, legacyRoot, cwd });

		expect(hint).toContain(`mv ${legacyRoot} ${customRoot}`);
		expect(hint).not.toContain("auto-memory");
	});

	// `mv <src> <dst>` 在 dst 已存在时会把 src 塞**进** dst（得到 <dst>/memory/…）：
	// 根已存在（别的项目先迁过了）时必须改成搬这一个项目的子目录。
	it("moves only this project's subdir when the new root already exists", async () => {
		await mkdir(legacyDir, { recursive: true });
		await mkdir(newRoot, { recursive: true }); // 根在，本项目的 newDir 不在

		const hint = await detectLegacyMemoryDir(opts());

		expect(hint).toContain(`mv ${legacyDir} ${newDir}`);
		expect(hint).toContain(`mkdir -p ${dirname(newDir)}`);
		expect(hint).not.toContain(`mv ${legacyRoot} ${newRoot}`);
	});

	// Review Focus #3：探测只许 existsSync，不许 mkdir / 不许碰 MemoryStore。
	it("creates and modifies nothing while probing", async () => {
		await mkdir(legacyDir, { recursive: true });
		await writeFile(join(legacyDir, "MEMORY.md"), "# Memory Index\n", "utf8");
		const before = await snapshotTree(base);

		await detectLegacyMemoryDir(opts());

		expect(await snapshotTree(base)).toEqual(before);
	});
});
