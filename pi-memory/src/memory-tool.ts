import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { indexCapacity, type IndexCapacity } from "./entry-index";
import type { MemoryStore } from "./memory-store";

/**
 * `memory` 工具的 action 全集。注册范围是**硬约束**（spec §4.3 / D12）：
 *
 * - 主 agent 与 extract 只拿到 5 个（`MAIN_AGENT_ACTIONS`）；
 * - `rename` / `rebuild_index` 是 dream 专属（`DREAM_ACTIONS`），且只经
 *   `runHeadlessAgent({ customTools })` 注入 dream 自己的 headless session，**不经**
 *   `pi.registerTool()` —— 既省每轮上下文，也避免主 agent 误用破坏结构的能力。
 */
export type MemoryAction = "add" | "replace" | "remove" | "list" | "search" | "rename" | "rebuild_index";

/**
 * 主 agent（`pi.registerTool`）与 extract 子会话共用的 5 个 action。
 *
 * **冻结**：`StringEnum` 按引用持有这个数组，谁 `push` 一下就会静默拓宽**已经注册**的
 * enum（D12 的注册范围是硬约束，不能靠约定守）。
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
 * 会改动磁盘的 action。只有它们成功完成后才回调 `onWrite`（spec §14：「extract 完成且有
 * 写入 → 通知写入条数」）—— `list` / `search` 是读，不算。
 */
const WRITE_ACTIONS: ReadonlySet<MemoryAction> = new Set<MemoryAction>([
	"add",
	"replace",
	"remove",
	"rename",
	"rebuild_index",
]);

export interface MemoryToolConfig {
	memIndexMaxLines: number;
	memIndexMaxBytes: number;
	sessionSearch: { maxSessions: number; maxMatches: number };
}

export interface MemoryToolDeps {
	/**
	 * 保留给诊断与 Plan C 的 `/memory` 状态输出。工具本身**不直接读目录** ——
	 * `MemoryStore` 是唯一写入通道，也是唯一的读取入口（D4）。
	 */
	getMemoryDir: () => string | null;
	/** `session_start` 之后才有值；为 null 时工具报「未初始化」而不是崩。 */
	getStore: () => MemoryStore | null;
	getConfig: () => MemoryToolConfig;
	/**
	 * 配置错误态（模型校验失败 / 初始化失败）。非 null 时，`getStore()` 为 null 的工具调用报
	 * **真实原因**并指向 `/memory`，而不是笼统的「还没 session_start」—— `/memory` 是重读它的唯一入口。
	 */
	getInitError: () => string | null;
	searchSessions: (cwd: string, query: string, cfg: { maxSessions: number; maxMatches: number }) => Promise<string>;
	cwd: () => string;
}

export interface MemoryToolOptions {
	/** 本 session 可见的 action 子集。缺省 = 主 agent 的 5 个。 */
	actions?: readonly MemoryAction[];
	/** 整轮逻辑锁持有者（dream / extract）传 true：它们的原语调用不得再去抢自己已持有的锁。 */
	skipLogicalLock?: boolean;
	/** dream 传 true：进入时已对整目录拍过一次快照，内部每个原语不再各拍一次。 */
	skipSnapshot?: boolean;
	/**
	 * 每次**成功**的写 action 之后回调（读 action 不回调，失败抛错也不回调）。
	 * index.ts 用它给 extract 统计本轮写入条数（spec §14）—— 工具跑在 headless 子会话里，
	 * 自己看不到 UI，只能把「写了几条」回报给宿主。
	 */
	onWrite?: (info: { action: MemoryAction; name?: string }) => void;
}

interface MemoryParams {
	action: MemoryAction;
	name?: string;
	description?: string;
	type?: "user" | "feedback" | "project" | "reference";
	content?: string;
	query?: string;
	scope?: "memory" | "sessions";
	new_name?: string;
}

const TYPE_VALUES = ["user", "feedback", "project", "reference"] as const;

/**
 * 参数 schema 由 `actions` **动态构建**：不在集合里的 action 不出现在枚举里，
 * `new_name` 也只在含 `rename` 的 schema（= dream）里存在。这是 D12 的执行点。
 */
function buildParameters(actions: readonly MemoryAction[]) {
	const props: Record<string, TSchema> = {
		action: StringEnum(actions, { description: "Which memory operation to perform." }),
		name: Type.Optional(
			Type.String({
				description:
					"Unique, human-readable title of the memory. Required for add; the lookup key for replace/remove/rename.",
			}),
		),
		description: Type.Optional(
			Type.String({
				description:
					"One self-contained line describing this memory. Future sessions pick memories from descriptions alone, so it must make sense without the body. Defaults to the first sentence of content.",
			}),
		),
		type: Type.Optional(StringEnum(TYPE_VALUES, { description: "Memory type. Defaults to feedback." })),
		content: Type.Optional(
			Type.String({
				description: "The memory body. Required for add and replace; it becomes the whole entry file.",
			}),
		),
		query: Type.Optional(Type.String({ description: "Search text (search)." })),
		scope: Type.Optional(
			StringEnum(["memory", "sessions"] as const, {
				description: "search target: memory entries (default) or past sessions.",
			}),
		),
	};
	if (actions.includes("rename")) {
		props.new_name = Type.Optional(
			Type.String({
				description: "New unique title for the memory (rename). Its file name and index line follow.",
			}),
		);
	}
	return Type.Object(props);
}

/**
 * 与 `MemoryStore.#capacityWarning` 同文案。`rebuildIndex` **不返回** capacityWarning
 * （已知 API 不一致，spec §19），所以 dream 的 `rebuild_index` 必须自己算一遍并把可操作的
 * 警告回给模型 —— 恢复原语恰恰最可能在膨胀目录上运行。
 */
function capacityWarning(cap: IndexCapacity, cfg: MemoryToolConfig): string {
	return (
		`MEMORY.md is over its limit: ${cap.lineCount}/${cfg.memIndexMaxLines} lines, ` +
		`${cap.byteLength}/${cfg.memIndexMaxBytes} bytes. The write succeeded, but everything past ` +
		"the limit is dropped on the next load. Rewrite it now: keep one line per entry, merge or drop " +
		"stale entries, and move detail into entry bodies rather than the index."
	);
}

export function createMemoryTool(deps: MemoryToolDeps, options: MemoryToolOptions = {}): ToolDefinition {
	const actions = options.actions ?? MAIN_AGENT_ACTIONS;
	const writeOpts = { skipLogicalLock: options.skipLogicalLock, skipSnapshot: options.skipSnapshot };

	return {
		name: "memory",
		label: "Memory",
		description:
			"Read/write persistent project memory. One memory = one file, and MEMORY.md holds exactly one index line per memory. action 'add' creates a memory, or overwrites the one whose name matches exactly; 'replace' rewrites an existing memory's content/description/type; 'remove' deletes it; 'list' shows every memory; 'search' queries memory entries (scope='memory', default) or past sessions (scope='sessions'). A memory's description is the only text a future session sees when deciding relevance, so it must be self-contained.",
		promptSnippet:
			"Read/write persistent project memory (one memory per file). Make every description self-contained — it is the only relevance signal future sessions get.",
		promptGuidelines: [
			"Use memory to persist project facts, user preferences, and lessons learned across sessions. Each memory lives in its own file and occupies exactly one line of the MEMORY.md index.",
			"Always pass a description with action 'add' and 'replace'. It must be self-contained and specific (what, where, which value), because future sessions select memories from descriptions alone. Bad: \"Debugging tips\". Good: \"staging SSH listens on 2222, not 22\".",
			"Give each memory a unique, human-readable name. Adding a name that already exists overwrites that memory instead of creating a second one — use 'search' or 'list' first when you are unsure.",
			"Keep one fact per memory and put the detail in content, not in name or description; the index line stays short.",
			"The index has a hard capacity limit. When a write reports that MEMORY.md is over its limit, act on it: merge related memories, remove stale ones, and move detail into content.",
			"Use action 'search' with scope='sessions' to find past work in history sessions.",
			"Relevant memories are surfaced automatically at the start of a turn inside <relevant_memories>; use 'search' or 'list' to look for anything else.",
		],
		parameters: buildParameters(actions),
		// biome-ignore lint/suspicious/noExplicitAny: renderCall args
		renderCall(args: any, theme: any) {
			let t = theme.fg("toolTitle", theme.bold("memory ")) + theme.fg("muted", String(args.action));
			if (args.name) t += ` ${theme.fg("accent", args.name)}`;
			if (args.new_name) t += ` ${theme.fg("accent", `→ ${args.new_name}`)}`;
			if (args.query) t += ` ${theme.fg("dim", `"${args.query}"`)}`;
			return new Text(t, 0, 0);
		},
		// biome-ignore lint/suspicious/noExplicitAny: renderResult expanded param
		renderResult(result: any, { expanded: _expanded }: any, theme: any) {
			const txt = result.content?.[0];
			const text = txt?.type === "text" ? txt.text : "";
			if (result.details?.error) return new Text(theme.fg("error", `Error: ${result.details.error}`), 0, 0);
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text.split("\n")[0]), 0, 0);
		},
		// biome-ignore lint/suspicious/noExplicitAny: execute params
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
			const store = deps.getStore();
			if (!store) {
				// 配置错误的会话里工具仍可能注册着（健康会话之后同一进程内又起了一个错误会话，pi 没有
				// unregister API）：此时「no session_start yet」是假话，把真实原因与 `/memory` 指出来。
				const initError = deps.getInitError();
				throw new Error(
					initError
						? `Memory not initialized — ${initError.split("\n")[0]}; run /memory for details`
						: "Memory not initialized (no session_start yet)",
				);
			}
			const cfg = deps.getConfig();
			const p = params as MemoryParams;
			// schema 的 action 枚举已经按 session 收窄过（D12）；这里是第二道门，防止模型硬编一个
			// 不在集合里的 action 而落到 switch 的 default 之外。
			if (!actions.includes(p.action)) throw new Error(`Unknown action: ${p.action}`);

			let text: string;
			// biome-ignore lint/suspicious/noExplicitAny: tool result details
			let details: any = {};

			switch (p.action) {
				case "add": {
					if (!p.name?.trim()) throw new Error("name is required for add");
					if (!p.content) throw new Error("content is required for add");
					const r = await store.addEntry(
						{ name: p.name, description: p.description, type: p.type, body: p.content },
						writeOpts,
					);
					text = `Saved "${p.name.trim()}" (${r.file}).`;
					// 容量超限**不抛错**（D9 / §8.2）：写入已经成功，但必须把可操作的警告回给模型，
					// 让它去重写索引。抛错会让模型以为记忆没存下来而重复写。
					if (r.capacityWarning) text += `\n\n${r.capacityWarning}`;
					details = { file: r.file, capacityWarning: r.capacityWarning };
					// spec §14：写成功了要让用户看见。headless 会话（extract / dream）hasUI=false，
					// 天然不通知；旧调用形状完全不传 ctx，所以用 `?.`。
					// 通知本身必须包起来（Plan C 终审 #11）：`ctx.ui` 是宿主代理，session dispose
					// 之后 notify 会抛 —— 一次**已经落盘**的写入不能因此变成工具错误，
					// 否则模型会以为没存下来而重复写。
					if (ctx?.hasUI) {
						try {
							ctx.ui.notify(`Saved: ${p.name.trim()}`, "info");
						} catch {
							/* UI 已失效：宿主不再收这条通知，写入结果不受影响 */
						}
					}
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
						// 与其余分支一致：details 不再留空（Plan B ledger 的 Minor）
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
					// rebuildIndex 不返回 capacityWarning（spec §19）：调用方自己检查。
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

			return { content: [{ type: "text", text }], details };
		},
	};
}
