import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileMutationQueue } from "../src/store/mutation-queue.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "am-mq-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * 负向断言用的已知时间窗口：注册一个调用只需要一次 `realpath` 系统调用（tmpfs 上 < 1ms），
 * 20ms 是它的 20 倍以上，足够让所有已发起的调用完成注册；同时远小于测试的总时长。
 * 不用 `waitFor`：这里断言的是「**没有**开始执行」，条件本来就不会成立（见 docs/guides/testing.md）。
 */
const REGISTRATION_WINDOW_MS = 20;

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, REGISTRATION_WINDOW_MS));

function gate(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("withFileMutationQueue", () => {
	it("serializes calls that target the same file", async () => {
		const target = join(dir, "MEMORY.md");
		const order: string[] = [];
		const hold = gate();

		const first = withFileMutationQueue(target, async () => {
			order.push("first:start");
			await hold.promise;
			order.push("first:end");
			return 1;
		});
		const second = withFileMutationQueue(target, async () => {
			order.push("second:start");
			return 2;
		});

		await settle();
		// second 已经注册（它的 promise 存在），但第一个还占着队列时它不得开始
		expect(order).toEqual(["first:start"]);

		hold.release();
		expect(await Promise.all([first, second])).toEqual([1, 2]);
		expect(order).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("does not block calls targeting a different file", async () => {
		const a = join(dir, "a.md");
		const b = join(dir, "b.md");
		const hold = gate();

		const slow = withFileMutationQueue(a, async () => {
			await hold.promise;
			return "a";
		});
		const fast = withFileMutationQueue(b, async () => "b");

		// a 仍挂住时 b 就已经完成 —— 不同文件互不阻塞
		expect(await fast).toBe("b");
		hold.release();
		expect(await slow).toBe("a");
	});

	it("treats an absolute path, a symlink and a relative spelling of one file as one queue", async () => {
		const real = join(dir, "MEMORY.md");
		await writeFile(real, "");
		const link = join(dir, "link.md");
		await symlink(real, link);
		const spelled = relative(process.cwd(), real);
		const order: string[] = [];
		const hold = gate();

		const p1 = withFileMutationQueue(real, async () => {
			order.push("real:start");
			await hold.promise;
			order.push("real:end");
		});
		const p2 = withFileMutationQueue(link, async () => {
			order.push("link:start");
		});
		const p3 = withFileMutationQueue(spelled, async () => {
			order.push("rel:start");
		});

		await settle();
		expect(order).toEqual(["real:start"]);

		hold.release();
		await Promise.all([p1, p2, p3]);
		// 注册顺序由 registrationQueue 固定，因此 link 一定排在 rel 前面
		expect(order).toEqual(["real:start", "real:end", "link:start", "rel:start"]);
	});

	it("falls back to the resolved path when realpath fails with ENOENT or ENOTDIR", async () => {
		const real = join(dir, "MEMORY.md");
		await writeFile(real, "");
		// 穿过一个普通文件的路径段 → ENOTDIR；不存在的中间目录 → ENOENT。
		// 两者都必须回落到 resolve() 的结果并正常排队，而不是把 realpath 的错误冒给调用方。
		const throughFile = join(real, "sub.md");
		const missing = join(dir, "nope", "MEMORY.md");

		expect(await withFileMutationQueue(throughFile, async () => "a")).toBe("a");
		expect(await withFileMutationQueue(missing, async () => "b")).toBe("b");
	});

	it("keeps the queue usable after a rejection", async () => {
		const target = join(dir, "MEMORY.md");

		await expect(
			withFileMutationQueue(target, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		// 前一个调用失败不得毒化队列：同一路径的下一次调用仍要执行
		expect(await withFileMutationQueue(target, async () => "still works")).toBe("still works");
	});

	it("propagates the original error to the failing caller only", async () => {
		const target = join(dir, "MEMORY.md");
		const ran: string[] = [];

		const failing = withFileMutationQueue(target, async (): Promise<string> => {
			throw new Error("first failed");
		});
		const following = withFileMutationQueue(target, async () => {
			ran.push("second ran");
			return "ok";
		});

		await expect(failing).rejects.toThrow("first failed");
		expect(await following).toBe("ok");
		expect(ran).toEqual(["second ran"]);
	});
});
