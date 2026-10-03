import { execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFsRetry } from "../src/fs-retry";

/**
 * 真机用例：用 .NET 的 `FileShare.None` 造出**真实的**共享冲突（杀软/编辑器打断写入时
 * Windows 给的就是这一类错误），验证 ① 短冲突会被重试跨过去 ② 长冲突仍按 fail-closed 报错。
 */
describe.skipIf(process.platform !== "win32")("withFsRetry against a real Windows sharing violation", () => {
	let dir: string;
	let target: string;
	let ready: string;
	const holders: ChildProcess[] = [];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-retry-win-"));
		target = join(dir, "target.txt");
		ready = join(dir, "ready.txt");
		await writeFile(target, "initial", "utf8");
	});
	afterEach(async () => {
		for (const holder of holders.splice(0)) holder.kill();
		await rm(dir, { recursive: true, force: true });
	});

	/** 后台独占 target `holdMs` 毫秒后释放；取得独占后写 ready 标记。 */
	function startExclusiveHold(holdMs: number): void {
		const script = [
			`$fs = [IO.File]::Open('${target}', 'Open', 'Read', 'None')`,
			`[IO.File]::WriteAllText('${ready}', 'ready')`,
			`Start-Sleep -Milliseconds ${holdMs}`,
			"$fs.Close()",
		].join("; ");
		holders.push(execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]));
	}

	async function waitForReady(): Promise<void> {
		for (let i = 0; i < 100; i++) {
			const up = await readFile(ready, "utf8").then(() => true, () => false);
			if (up) return;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error("the exclusive holder never became ready");
	}

	it("crosses a short exclusive hold", async () => {
		startExclusiveHold(600); // 就绪后仅占 600ms ＜ 重试预算 ≈900ms
		await waitForReady();
		await expect(withFsRetry(() => writeFile(target, "written", "utf8"))).resolves.toBeUndefined();
		expect(await readFile(target, "utf8")).toBe("written");
	});

	it("fails closed after the budget when the hold outlasts it", async () => {
		startExclusiveHold(8000); // 远超重试预算
		await waitForReady();
		const started = Date.now();
		const err = await withFsRetry(() => writeFile(target, "written", "utf8")).catch((e: unknown) => e);
		expect((err as NodeJS.ErrnoException).code).toMatch(/^(EPERM|EACCES|EBUSY)$/);
		expect(Date.now() - started).toBeLessThan(5000);
	});
});
