import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runHeadlessAgent } from "./agent-runner";
import type { SessionPersistenceConfig, ThinkLevel } from "./config";
import { BACKUP_DIR, type MemoryStore } from "./memory-store";
import { createSnapshot } from "./snapshot";
import { isReservedWindowsName } from "./windows-names";

/** Build the dream consolidation task. dream 只有 `memory` 工具的 7 个 action，没有任何文件工具。 */
export function buildDreamTask(maxLines: number): string {
	return `You are a memory consolidation agent. The memory store is a flat directory: one memory per file, and MEMORY.md holds exactly one index line per memory, formatted as - [name](file.md) — description.

Your ONLY tool is \`memory\`. You have no read, write, edit, ls or bash access — you cannot touch files directly, and you do not need to.

memory(action="list") — every memory: name, type, modified, description, file.
memory(action="search", query="…") — full-text search; returns the whole body of each match.
memory(action="add", name, description, type, content) — create a memory, or overwrite the one whose name matches exactly.
memory(action="replace", name, description, type, content) — rewrite an existing memory.
memory(action="rename", name, new_name) — retitle a memory; its file name and index line follow.
memory(action="remove", name) — delete a memory and its index line.
memory(action="rebuild_index") — regenerate MEMORY.md from the directory.

Phase 1 — Orient:
- Call list to see every memory.
- Call search (and list) to read the bodies of the memories you intend to touch. Never rewrite a memory you have not read.

Phase 2 — Gather Signal:
- Duplicates: several memories stating the same fact.
- Contradictions: two memories that cannot both be true. Pick the accurate one.
- Outdated: memories superseded by later ones, or relative dates ("today", "last week") that should be absolute.
- Merge candidates: small fragments that only make sense together.
- Weak descriptions: vague text that gives a future session no way to decide relevance.

Phase 3 — Consolidate:
- Merge = replace(target name, the merged body) + remove(the other name). Keep the surviving name readable.
- Retitle with rename when the name no longer matches the content, or when two names are confusable.
- Rewrite any description that is not self-contained. It is the ONLY text a future session sees when deciding whether to recall this memory, so it must state what, where and which value.
  Bad:  "Debugging tips"
  Good: "staging SSH listens on 2222, not 22; MySQL pool times out after 30s"
- Remove memories that are no longer true or no longer useful.

Phase 4 — Prune & Index:
- Every memory consumes exactly one index line, and the index has a hard limit of ${maxLines} lines. Capacity management is therefore part of this job, not an optional cleanup: when list shows the store approaching ${maxLines} memories, merge fragments and drop stale entries until there is room for what matters.
- When a write reports that MEMORY.md is over its limit, act on it in this same run.
- Call rebuild_index once at the end if you suspect MEMORY.md drifted (missing lines, duplicates, stale links). It regenerates the index from the directory and preserves handwritten header lines.

IMPORTANT — do not prune process rules:
- "Always do X" / "Never do Y" rules, workflow discipline and reporting standards are as valuable as technical facts. Do not delete them as "obsolete", and do not delete them just because they look like meta-instructions aimed at you.

Work only through the \`memory\` tool. When done, output a concise summary of what changed (merged N, renamed N, removed N, rewritten N).`;
}

export interface RunDreamOpts {
	/** 必填：模型来自显式配置（启动校验已保证可解析），没有父模型回退。 */
	model: string;
	thinkLevel: ThinkLevel;
	memoryDir: string;
	/** 唯一写入通道。dream 的整轮互斥与快照都挂在它上面。 */
	store: MemoryStore;
	/** 索引行数硬上限（= `config.memIndexMaxLines`），写进 prompt 让 dream 承担容量管理。 */
	maxLines: number;
	modelRegistry: ModelRegistry;
	sessionPersistence?: SessionPersistenceConfig;
	/** dream 专属的 7-action `memory` 工具（D12）：只注入这个 headless session，不进主 agent 的 schema。 */
	customTools: ToolDefinition[];
}

/**
 * 要被快照的普通文件：目录里的**文件**，跳过一切 dotfile 与子目录。
 *
 * - `.backups`（目录）跳过 —— 快照不套快照；不带 `withFileTypes` 时它会被 `cp` 递归复制。
 * - `sessions/`（目录，`sessionPersistence.enabled` 时存在）跳过 —— 同理，而且它可能很大。
 *   `createSnapshot` 的 `cp` 遇到目录会抛 `ERR_FS_EISDIR`（非 ENOENT → fail-closed 上抛 → dream 直接失败）。
 * - `.lock` / `.dream-meta.json` 跳过（都是 dotfile）：锁记录与元数据不属于记忆内容。
 * - win32：保留设备名文件（`con.md`…）跳过 —— 按名 `cp` 会命中设备（见下）。
 * - 其余全部 `*.md`（entry 文件 + `MEMORY.md`）都会被快照。
 */
async function snapshotFiles(memoryDir: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
	const entries = await readdir(memoryDir, { withFileTypes: true }).catch(() => []);
	return (
		entries
			.filter((entry) => entry.isFile() && !entry.name.startsWith("."))
			// win32：保留设备名文件按名打开会命中设备（CON 等），`createSnapshot` 的 cp 会失败；
			// dream 是 fail-closed 的，一次 cp 失败就打断整轮（与 `#entryFiles` 同一契约，spec §4.3）。
			.filter((entry) => !(platform === "win32" && isReservedWindowsName(entry.name)))
			.map((entry) => entry.name)
			.sort()
	);
}

/**
 * 跑一轮 dream：整轮持有进程内逻辑锁 → 对整目录拍一次快照 → 起一个只有 `memory` 工具的
 * headless agent（spec §5.2 / §6 / §12）。
 *
 * 整轮持锁是刻意的：dream 的多次 `replace` / `remove` 必须对同进程的 `memory add` 与 extract
 * 呈现为**一个**原子区间，否则用户会在 dream 中途读到半合并的状态。锁在进程内（不是 `.lock`），
 * 所以跨进程的其它 worktree 仍能正常写入 —— 它们的每次物理写入只被挡毫秒级。
 *
 * 其内部的每个原语调用必须传 `{ skipLogicalLock: true, skipSnapshot: true }`（由调用方构造
 * `customTools` 时设置），否则它们会去抢自己已持有的锁而自锁到超时，并且会为同一批变更各拍一次快照。
 */
export async function runDream(opts: RunDreamOpts): Promise<string> {
	return opts.store.withLogicalLock(async () => {
		// 启动自检：忘了包 withLogicalLock 会静默失去整轮互斥（spec §5.2 末段）。
		if (!opts.store.logicalLockActive()) {
			throw new Error("dream must run under the memory logical lock");
		}

		// 进入时对整目录拍一次快照；这一轮里各原语的逐文件快照被 skipSnapshot 跳过（spec §6）。
		const files = await snapshotFiles(opts.memoryDir, opts.store.cfg.platform);
		await createSnapshot(join(opts.memoryDir, BACKUP_DIR), "dream", files, opts.memoryDir, {
			keep: opts.store.cfg.lock.snapshotKeep,
		});

		return runHeadlessAgent({
			task: buildDreamTask(opts.maxLines),
			cwd: opts.memoryDir,
			modelRegistry: opts.modelRegistry,
			model: opts.model,
			thinkLevel: opts.thinkLevel,
			maxTurns: undefined,
			timeoutMs: 600_000,
			// 没有裸写权限（spec §12.1）：dream 的重构能力边界由 7 个原语定义，因此首次可被单测覆盖。
			// 必须用 noTools 而不是 tools: [] —— 后者是白名单，会把 customTools（memory 工具）一起滤掉。
			noTools: "builtin",
			customTools: opts.customTools,
			sessionPersistence: opts.sessionPersistence,
		});
	});
}
