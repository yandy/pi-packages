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

/**
 * 脱掉宿主为 section 值加的一层包裹（R42）。
 *
 * 0.99.2 `core/system-prompt.js` 把每个非 `preamble` section 渲染成
 * `<${name}>\n${content}\n</${name}>` 之后才写进 transcript；`sessionEntryToContextMessages`
 * 原样返回录制消息，所以重放拿到的是**带标签**的值。直接回写成 `options.sections[name]`
 * 会被宿主二次包裹：`wrap(wrap(x)) !== wrap(x)` —— resume/fork/reload 第一轮就产生 patch
 *（D13/D14 的头部字节恒等失效），内层闭合标签还会提前闭合外层标签。
 *
 * 只脱一层；不匹配（裸值、老 session、内容碰巧含标签）原样返回。
 */
export function unwrapSectionValue(value: string): string {
	const prefix = `<${MEMORY_INDEX_SECTION}>\n`;
	const suffix = `\n</${MEMORY_INDEX_SECTION}>`;
	if (value.length >= prefix.length + suffix.length && value.startsWith(prefix) && value.endsWith(suffix)) {
		return value.slice(prefix.length, value.length - suffix.length);
	}
	return value;
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
 *
 * 返回值是**裸值**：宿主把 section 渲染成 `<memory_index>…</memory_index>` 后才写进
 * transcript，所以这里要脱掉那一层再回写（R42 / `unwrapSectionValue`）。
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

	let leafId: string | null = null;
	try {
		leafId = sm.getLeafId();
	} catch {
		// Finding 2 / R43：这个函数在 index.ts 的 session_start 路径上被调用，抛错会让整个
		// session_start 失败 → memory 工具整个会话不注册。拿不到 leaf 就退化成「没有 branch」：
		// 用全部 entry 重放，多出来的 system patch 只会被后面的覆盖或删掉。
	}
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
	return typeof recorded === "string" ? unwrapSectionValue(recorded) : null;
}
