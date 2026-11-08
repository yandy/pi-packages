import { indexCapacity, type IndexCapacity } from "../store/entry-index.js";
import type { EntryType } from "../store/entry-file.js";
import type { MemoryStore } from "../store/memory-store.js";
import { MAIN_AGENT_ACTIONS, WRITE_ACTIONS, type MemoryAction } from "./actions.js";

/** handler 需要的宿主/适配层能力。全是纯函数，没有任何宿主类型。 */
export interface MemoryHandlerDeps {
	/** `MemoryStore` 是唯一写入通道，也是唯一读取入口。为 null 时报「未初始化」而不是崩。 */
	getStore(): MemoryStore | null;
	getConfig(): MemoryHandlerConfig;
	/**
	 * `getStore()` 为 null 时的完整可读原因（由适配层依会话状态拼好），null = 还没初始化。
	 * handler 只负责原样抛出，不猜状态。
	 */
	getUnavailableMessage(): string | null;
	/** `search scope=sessions` 的宿主实现：返回已格式化好的文本。 */
	searchSessions(cwd: string, query: string, cfg: { maxSessions: number; maxMatches: number }): Promise<string>;
	cwd(): string;
}

export interface MemoryHandlerConfig {
	memIndexMaxLines: number;
	memIndexMaxBytes: number;
	sessionSearch: { maxSessions: number; maxMatches: number };
}

export interface MemoryHandlerOptions {
	/** 本次可见的 action 子集。缺省 = 主 agent 的 5 个。 */
	actions?: readonly MemoryAction[];
	/** 整轮逻辑锁持有者（dream / extract）传 true：它们的原语调用不得再去抢自己已持有的锁。 */
	skipLogicalLock?: boolean;
	/** dream 传 true：进入时已对整目录拍过一次快照，内部每个原语不再各拍一次。 */
	skipSnapshot?: boolean;
	/**
	 * 每次**成功**的写 action 之后回调（读 action 不回调，失败抛错也不回调）。
	 * 适配层用它统计一轮写入了几条：handler 跑在 headless 子会话里，自己看不到 UI。
	 */
	onWrite?: (info: { action: MemoryAction; name?: string }) => void;
}

/** 给模型看的文本 + 给宿主看的结构化结果。 */
export interface MemoryActionResult {
	text: string;
	details: Record<string, unknown>;
}

interface MemoryParams {
	action: MemoryAction;
	name?: string;
	description?: string;
	type?: EntryType;
	content?: string;
	query?: string;
	scope?: "memory" | "sessions";
	new_name?: string;
}

/**
 * 与 `MemoryStore` 的容量警告同文案。`rebuildIndex` **不返回** capacityWarning（已知 API 不一致），
 * 所以 dream 的 `rebuild_index` 必须自己算一遍并把可操作的警告回给模型 —— 恢复原语恰恰最可能在
 * 膨胀目录上运行。
 */
export function capacityWarning(cap: IndexCapacity, cfg: MemoryHandlerConfig): string {
	return (
		`MEMORY.md is over its limit: ${cap.lineCount}/${cfg.memIndexMaxLines} lines, ` +
		`${cap.byteLength}/${cfg.memIndexMaxBytes} bytes. The write succeeded, but everything past ` +
		"the limit is dropped on the next load. Rewrite it now: keep one line per entry, merge or drop " +
		"stale entries, and move detail into entry bodies rather than the index."
	);
}

/**
 * `memory` 工具的分派逻辑：action → `MemoryStore` 调用 → 给模型的文本。
 *
 * 适配层只需要把返回值包成宿主的工具结果（pi：`{ content: [{ type: "text", text }], details }`），
 * 以及在自己的通道上发通知 —— 通知**不在这里**，因为「有没有 UI、怎么弹」是宿主知识。
 */
export function createMemoryActionHandler(
	deps: MemoryHandlerDeps,
	options: MemoryHandlerOptions = {},
): (params: unknown) => Promise<MemoryActionResult> {
	const actions = options.actions ?? MAIN_AGENT_ACTIONS;
	const writeOpts = { skipLogicalLock: options.skipLogicalLock, skipSnapshot: options.skipSnapshot };

	return async (params: unknown): Promise<MemoryActionResult> => {
		const store = deps.getStore();
		if (!store) {
			throw new Error(deps.getUnavailableMessage() ?? "Memory not initialized (no store for this session yet)");
		}
		const cfg = deps.getConfig();
		const p = params as MemoryParams;
		// schema 的 action 枚举已经按会话收窄过；这里是第二道门，防止模型硬编一个不在集合里的
		// action 而落到 switch 的 default 之外。
		if (!actions.includes(p.action)) throw new Error(`Unknown action: ${p.action}`);

		let text: string;
		let details: Record<string, unknown> = {};

		switch (p.action) {
			case "add": {
				if (!p.name?.trim()) throw new Error("name is required for add");
				if (!p.content) throw new Error("content is required for add");
				const r = await store.addEntry(
					{ name: p.name, description: p.description, type: p.type, body: p.content },
					writeOpts,
				);
				text = `Saved "${p.name.trim()}" (${r.file}).`;
				// 容量超限**不抛错**：写入已经成功，但必须把可操作的警告回给模型，让它去重写索引。
				// 抛错会让模型以为记忆没存下来而重复写。
				if (r.capacityWarning) text += `\n\n${r.capacityWarning}`;
				details = { file: r.file, capacityWarning: r.capacityWarning };
				break;
			}
			case "replace": {
				if (!p.name?.trim()) throw new Error("name is required for replace");
				if (!p.content) throw new Error("content is required for replace");
				// 不改名：改名是 dream 专属的 `rename`（且 `replaceEntry` 的改名路径会在撞名时报错）。
				const r = await store.replaceEntry(
					p.name,
					{ description: p.description, type: p.type, body: p.content },
					writeOpts,
				);
				text = `Replaced "${p.name.trim()}" (${r.file}).`;
				if (r.capacityWarning) text += `\n\n${r.capacityWarning}`;
				details = { file: r.file, capacityWarning: r.capacityWarning };
				break;
			}
			case "remove": {
				if (!p.name?.trim()) throw new Error("name is required for remove");
				await store.removeEntry(p.name, writeOpts);
				text = `Removed "${p.name.trim()}".`;
				details = { removed: p.name.trim() };
				break;
			}
			case "list": {
				const entries = await store.listEntries();
				text =
					entries.length === 0
						? "No memories yet."
						: entries
								.map((e) => `- ${e.name} (${e.type}, modified ${e.modified}) — ${e.description} [${e.file}]`)
								.join("\n");
				details = { count: entries.length };
				break;
			}
			case "search": {
				if (!p.query?.trim()) throw new Error("query is required for search");
				if (p.scope === "sessions") {
					text = await deps.searchSessions(deps.cwd(), p.query, cfg.sessionSearch);
					details = { scope: "sessions", query: p.query.trim() };
					break;
				}
				const hits = await store.searchEntries(p.query);
				text =
					hits.length === 0
						? "No matches in memory."
						: hits.map((e) => `## ${e.name}\nfile: ${e.file}\ntype: ${e.type}\n\n${e.body}`).join("\n\n");
				details = { count: hits.length };
				break;
			}
			case "rename": {
				if (!p.name?.trim()) throw new Error("name is required for rename");
				if (!p.new_name?.trim()) throw new Error("new_name is required for rename");
				const r = await store.renameEntry(p.name, p.new_name, writeOpts);
				text = `Renamed "${p.name.trim()}" → "${p.new_name.trim()}" (${r.file}).`;
				details = { file: r.file };
				break;
			}
			case "rebuild_index": {
				const r = await store.rebuildIndex(writeOpts);
				// rebuildIndex 不返回 capacityWarning：调用方自己检查。
				const cap = indexCapacity(await store.readIndex(), cfg.memIndexMaxLines, cfg.memIndexMaxBytes);
				text = `Rebuilt index: ${r.entries} entries (${r.headerLines} header lines).`;
				if (!cap.ok) text += `\n\n${capacityWarning(cap, cfg)}`;
				details = { entries: r.entries, headerLines: r.headerLines, overCapacity: !cap.ok };
				break;
			}
			default:
				throw new Error(`Unknown action: ${String(p.action)}`);
		}

		// 写在 switch 之后：任何抛错都会跳过它，于是「成功完成写 action」是唯一触发条件。
		if (WRITE_ACTIONS.has(p.action)) options.onWrite?.({ action: p.action, name: p.name?.trim() });

		return { text, details };
	};
}
