import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionPersistenceConfig } from "../config.js";
import { BACKUP_DIR, type MemoryStore } from "../store/memory-store.js";
import { createSnapshot } from "../store/snapshot.js";
import { isReservedWindowsName } from "../store/windows-names.js";
import { DREAM_ACTIONS } from "../tool/actions.js";
import { buildDreamTask } from "./prompts.js";
import type { HeadlessAgentPort } from "./ports.js";

export interface RunDreamOpts {
	/** 必填：模型来自显式配置（启动校验已保证可解析），没有父模型回退。 */
	model: string;
	/** 宿主的思考/推理档位。core 不解释，原样透传给端口。 */
	effort?: string;
	memoryDir: string;
	/** 唯一写入通道。dream 的整轮互斥与快照都挂在它上面。 */
	store: MemoryStore;
	/** 索引行数硬上限（= `config.memIndexMaxLines`），写进 prompt 让 dream 承担容量管理。 */
	maxLines: number;
	sessionPersistence?: SessionPersistenceConfig;
}

async function snapshotFiles(memoryDir: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
	const entries = await readdir(memoryDir, { withFileTypes: true }).catch(() => []);
	return (
		entries
			.filter((entry) => entry.isFile() && !entry.name.startsWith("."))
			// win32：保留设备名文件按名打开会命中设备（CON 等），`createSnapshot` 的 cp 会失败；
			// dream 是 fail-closed 的，一次 cp 失败就打断整轮（与 `MemoryStore` 的 `#entryFiles` 同一契约）。
			.filter((entry) => !(platform === "win32" && isReservedWindowsName(entry.name)))
			.map((entry) => entry.name)
			.sort()
	);
}

/**
 * 跑一轮 dream：整轮持有进程内逻辑锁 → 对整目录拍一次快照 → 起一个只有 `memory` 工具的
 * headless 会话。
 *
 * 整轮持锁是刻意的：dream 的多次 `replace` / `remove` 必须对同进程的 `memory add` 与 extract
 * 呈现为**一个**原子区间，否则用户会在 dream 中途读到半合并的状态。锁在进程内（不是 `.lock`），
 * 所以跨进程的其它 worktree 仍能正常写入 —— 它们的每次物理写入只被挡毫秒级。
 *
 * 其内部的每个原语调用必须带 `{ skipLogicalLock: true, skipSnapshot: true }`（由 `memoryTool`
 * 请求字段表达，适配层据此构造子会话的工具），否则它们会去抢自己已持有的锁而自锁到超时，
 * 并且会为同一批变更各拍一次快照。
 */

export async function runDream(opts: RunDreamOpts, ports: { headless: HeadlessAgentPort }): Promise<string> {
	return opts.store.withLogicalLock(async () => {
		// 启动自检：忘了包 withLogicalLock 会静默失去整轮互斥。
		if (!opts.store.logicalLockActive()) {
			throw new Error("dream must run under the memory logical lock");
		}

		// 进入时对整目录拍一次快照；这一轮里各原语的逐文件快照被 skipSnapshot 跳过。
		const files = await snapshotFiles(opts.memoryDir, opts.store.cfg.platform);
		await createSnapshot(join(opts.memoryDir, BACKUP_DIR), "dream", files, opts.memoryDir, {
			keep: opts.store.cfg.lock.snapshotKeep,
			platform: opts.store.cfg.platform,
		});

		const result = await ports.headless.run({
			task: buildDreamTask(opts.maxLines),
			cwd: opts.memoryDir,
			model: opts.model,
			effort: opts.effort,
			maxTurns: undefined,
			timeoutMs: 600_000,
			// 没有裸写权限：dream 的重构能力边界由 7 个原语定义，因此首次可被单测覆盖。
			builtinTools: "none",
			// dream 专属的 7 个 action；整轮持锁与进入时的全目录快照都在外面，所以两个 skip 都开。
			memoryTool: { actions: DREAM_ACTIONS, skipLogicalLock: true, skipSnapshot: true },
			sessionPersistence: opts.sessionPersistence,
		});
		// `null` = 宿主没跑这一轮。dream 是用户显式触发的（`/dream` 或 nudge 确认后），
		// 静默返回空摘要会让用户以为合并成功了 —— 显式抛错，由适配层转成失败通知。
		if (result === null) throw new Error("the host did not run the dream round");
		return result;
	});
}
