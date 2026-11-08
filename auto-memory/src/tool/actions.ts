/**
 * `memory` 工具的 action 全集与注册范围。
 *
 * 注册范围是**硬约束**：
 * - 主 agent 与 extract 子会话只拿到 5 个（`MAIN_AGENT_ACTIONS`）；
 * - `rename` / `rebuild_index` 是 dream 专属（`DREAM_ACTIONS`），只注入 dream 自己的 headless
 *   子会话，不进主 agent 的 schema —— 既省每轮上下文，也避免主 agent 误用破坏结构的能力。
 */
export type MemoryAction = "add" | "replace" | "remove" | "list" | "search" | "rename" | "rebuild_index";

/**
 * 主 agent 与 extract 子会话共用的 5 个 action。
 *
 * **冻结**：适配器按引用持有这个数组去建 enum，谁 `push` 一下就会静默拓宽**已经注册**的 schema。
 */
export const MAIN_AGENT_ACTIONS: readonly MemoryAction[] = Object.freeze([
	"add",
	"replace",
	"remove",
	"list",
	"search",
]);

/** dream 子会话专属的 7 个 action（额外 `rename` / `rebuild_index`）。同样冻结。 */
export const DREAM_ACTIONS: readonly MemoryAction[] = Object.freeze([
	"add",
	"replace",
	"remove",
	"list",
	"search",
	"rename",
	"rebuild_index",
]);

/**
 * 会改动磁盘的 action。只有它们成功完成后才回调 `onWrite` ——`list` / `search` 是读，不算。
 * 供 `handler.ts` 内部使用，不属于公开 API。
 */
export const WRITE_ACTIONS: ReadonlySet<MemoryAction> = new Set<MemoryAction>([
	"add",
	"replace",
	"remove",
	"rename",
	"rebuild_index",
]);
