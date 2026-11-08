import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFileMutationQueue } from "../src/store/mutation-queue.js";

/**
 * `getMutationQueueKey` 的错误分派：只有「路径不存在」才回落，其余一律上抛。
 *
 * 单独一个文件是因为这里要 mock `node:fs/promises` 的 `realpath` —— 真实的 `EACCES` 无法可移植地
 * 造出来（CI 可能以 root 跑，Windows 没有 POSIX 权限位），而把它 mock 进
 * `mutation-queue.test.ts` 会连带影响那 6 条用真实文件系统的用例。
 */
const { realpathMock } = vi.hoisted(() => ({ realpathMock: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	// 默认走真实现：只有显式 mockRejectedValueOnce 的那一次才失败
	realpathMock.mockImplementation(actual.realpath);
	return { ...actual, realpath: realpathMock };
});

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "am-mq-realpath-"));
	realpathMock.mockClear();
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const fsError = (code: string): Error => Object.assign(new Error(`fake ${code}`), { code });

describe("getMutationQueueKey error dispatch", () => {
	it("propagates a non-missing realpath failure instead of degrading to a per-spelling queue", async () => {
		const target = join(dir, "MEMORY.md");
		const eacces = fsError("EACCES");
		realpathMock.mockRejectedValueOnce(eacces);
		const fn = vi.fn(async () => "never");

		// 静默回落成 resolve() 的结果，会让「同一个文件的两种拼写」拿到两条队列 ——
		// 那正是这道 key 派生要防止的事，所以这里必须 fail loud。
		await expect(withFileMutationQueue(target, fn)).rejects.toBe(eacces);
		expect(fn).not.toHaveBeenCalled();
	});

	it("keeps the queue usable after such a failure", async () => {
		const target = join(dir, "MEMORY.md");
		realpathMock.mockRejectedValueOnce(fsError("EIO"));
		await expect(withFileMutationQueue(target, async () => "x")).rejects.toThrow("fake EIO");

		// 失败发生在 key 派生阶段、早于 map.set，所以不会留下半条链
		expect(await withFileMutationQueue(target, async () => "ok")).toBe("ok");
	});

	// 对照组：判别依据是**错误码**，不是「realpath 失败就抛」。
	it("still falls back for ENOENT and ENOTDIR, which are the normal not-there-yet cases", async () => {
		for (const code of ["ENOENT", "ENOTDIR"]) {
			realpathMock.mockRejectedValueOnce(fsError(code));
			expect(await withFileMutationQueue(join(dir, `${code}.md`), async () => code)).toBe(code);
		}
	});

	it("derives the key through realpath when it succeeds", async () => {
		const target = join(dir, "MEMORY.md");
		await withFileMutationQueue(target, async () => "ok");
		expect(realpathMock).toHaveBeenCalledWith(expect.stringContaining("MEMORY.md"));
	});
});
