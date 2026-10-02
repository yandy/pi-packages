import * as sdk from "@earendil-works/pi-coding-agent";

/**
 * 索引 section 的名字（spec §9.1）。pi 要求 section 名匹配 `/^[a-z][a-z0-9_-]*$/`
 * （0.99.2 `core/system-prompt.js`），渲染为 `<memory_index>…</memory_index>`。
 */
export const MEMORY_INDEX_SECTION = "memory_index";

/**
 * 重放录制值所需的最小 `SessionManager` 面（结构类型）。
 *
 * 本地类型是 pi-coding-agent **0.80.2**，它的 `ReadonlySessionManager` 没有
 * `buildContextEntries`（0.99.2 才加），所以这里不 import SDK 的类型，而是按结构声明：
 * 0.80.2 能过 `tsc`，0.99.2 的实例天然满足，测试也能直接塞假对象。
 */
export interface ReplayableSessionManager {
	getEntries(): unknown[];
	getLeafId(): string | null;
	buildContextEntries?(entries: unknown[], leafId?: string | null): unknown[];
}

/** 可注入的转换函数（测试用；生产路径从 SDK 包根动态取）。 */
export interface ReplayOpts {
	sessionEntryToContextMessages?: (entry: unknown) => unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 按 pi 的 patch 语义重放 transcript 里的 system 消息，得到「模型当前看到的 sections」。
 *
 * - `value === null` → **删除**该 section（pi 用 null 表示「不存在」，
 *   `diffSystemPromptSections` 对「上一状态有、当前状态没有」正是生成 `patch[name] = null`）；
 * - 字符串 → 覆盖值，并**保留首次插入位置**（`Map.set` 对已存在的键不改位置）——
 *   折叠路径 `getCurrentSystemMessage` 按顺序重放，位置本身就是语义的一部分。
 */
export function replaySystemSections(messages: unknown[]): Map<string, string> {
	const sections = new Map<string, string>();
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "system") continue;
		const patch = message.sections;
		if (!isRecord(patch)) continue;
		for (const [name, value] of Object.entries(patch)) {
			if (value === null) sections.delete(name);
			else if (typeof value === "string") sections.set(name, value);
		}
	}
	return sections;
}

/**
 * 动态取 SDK 包根的 `sessionEntryToContextMessages`。
 *
 * 不能写成 `import { sessionEntryToContextMessages } from "…"`：本地类型是 0.80.2，
 * 具名导入会让 `tsc` 直接报 `has no exported member`，而这个包**不得**动 peerDependencies /
 * lockfile。取不到就返回 null，调用方回退磁盘读（spec §19 的退路）。
 */
function resolveConverter(): ((entry: unknown) => unknown[]) | null {
	const candidate = (sdk as unknown as Record<string, unknown>).sessionEntryToContextMessages;
	return typeof candidate === "function" ? (candidate as (entry: unknown) => unknown[]) : null;
}

/**
 * 从 transcript 里取出**录制的**索引值（D14：resume / fork / reload 必须用它，
 * 否则被恢复会话的 system prompt 头部会被改写，折叠路径下其后的整段对话全部失去缓存）。
 *
 * 任何一步不可得都返回 `null`，由调用方回退磁盘读：SDK 太旧（没有转换函数）、
 * sessionManager 形状不认识、entry 转换抛错、重放后没有这个键、或该键被 `null` patch 删除。
 * **绝不把 `null` 当录制值返回**（spec §9.1 的 null 陷阱）。
 */
export function readRecordedMemoryIndex(sessionManager: unknown, opts?: ReplayOpts): string | null {
	const toMessages = opts?.sessionEntryToContextMessages ?? resolveConverter();
	if (!toMessages) return null;
	if (!isRecord(sessionManager)) return null;
	const sm = sessionManager as unknown as Partial<ReplayableSessionManager>;
	if (typeof sm.getEntries !== "function" || typeof sm.getLeafId !== "function") return null;

	let entries: unknown[] = [];
	try {
		const raw = sm.getEntries();
		if (Array.isArray(raw)) entries = raw;
	} catch {
		return null;
	}

	const leafId = sm.getLeafId();
	if (typeof sm.buildContextEntries === "function") {
		try {
			const built = sm.buildContextEntries(entries, leafId);
			if (Array.isArray(built)) entries = built;
		} catch {
			// 解析不出当前分支就用全部 entry：多出来的 system patch 只会被后面的覆盖或删掉
		}
	}

	const messages: unknown[] = [];
	for (const e of entries) {
		try {
			const converted = toMessages(e);
			if (Array.isArray(converted)) messages.push(...converted);
		} catch {
			// 单条 entry 的形状不认识：跳过它，别让整次重放失败
		}
	}

	const recorded = replaySystemSections(messages).get(MEMORY_INDEX_SECTION);
	return typeof recorded === "string" ? recorded : null;
}
