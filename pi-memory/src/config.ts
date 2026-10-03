import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Session persistence configuration for headless memory-agent sub-sessions. */
export interface SessionPersistenceConfig {
	/** Enable disk persistence (default: false = in-memory). */
	enabled: boolean;
	/** Custom session directory. Defaults to `<project memory dir>/sessions/` (the resolved per-project directory under `memoryDir`). */
	sessionDir?: string;
}

/** Shared defaults that per-task configs inherit. Per-task fields override these. */
export interface DefaultsConfig {
	/** 共享模型：per-task 未指定时生效。**没有默认值** —— 必须由用户显式配置。 */
	model?: string;
	sessionPersistence?: SessionPersistenceConfig;
}

export interface AutoSurfacingConfig {
	enabled: boolean;
	model?: string;
	thinkLevel: ThinkLevel;
	maxFiles: number;
	/**
	 * 单条 entry 注入正文的字节上限。
	 * v1 叫 `maxTopicBytes`（一个 topic 文件含多个 `##` 条目）；v2 一个 entry 一个文件，故改名。
	 * **旧键不再生效**（`deepMerge` 会把它挂到对象上，但没有任何代码读它）。
	 */
	maxEntryBytes: number;
	maxInjectionBytes: number;
}

export interface ExtractMemoriesConfig {
	/** 每轮自动提取。opt-in：默认 `false` —— 开启后每轮结束都会跑一次 headless 模型调用。 */
	enabled: boolean;
	model?: string;
	thinkLevel: ThinkLevel;
	maxContextTokens: number;
	/** 渲染进 extract prompt 时，单条 tool_result 的字符上限（spec §11.2）。 */
	maxToolResultChars: number;
	/** 渲染进 extract prompt 时，单条 assistant 文本的字符上限（spec §11.2）。 */
	maxAssistantChars: number;
}

export interface MemoryConfig {
	/** Shared defaults for model and sessionPersistence. Per-task configs override. */
	defaults?: DefaultsConfig;
	memoryDir: string;
	/** Write capacity: max entries in MEMORY.md index. */
	memIndexMaxLines: number;
	/** Write capacity: max bytes of serialized MEMORY.md index. */
	memIndexMaxBytes: number;
	/**
	 * 注入截断：`memory_index` section 最多带多少**行**索引（默认 50）。
	 * 窗口取索引**最新**的一段（索引是纯时间序，见 `truncateIndexForInjection`），所以被丢掉的
	 * 永远是**最旧**的记忆。写入口径（`memIndexMaxLines`）刻意**不随**它收紧：索引里能留更多条目，
	 * 超窗口的部分只靠 auto-surfacing / `memory` 工具检索，不进 system prompt。
	 */
	memIndexInjectMaxLines: number;
	/** 注入截断：`memory_index` section 最多带多少**字节**（默认 16384 ≈ 50 条中文索引行的实测上界）。 */
	memIndexInjectMaxBytes: number;
	/**
	 * 两级锁的参数（spec §5.2）。结构与 `StoreConfig["lock"]` 逐字一致，因此可以原样传给
	 * `new MemoryStore({ ..., lock: config.lock })`。
	 * **没有** ttl / 心跳 / 接管字段：跨进程 `.lock` 永远只持毫秒且永不自动回收。
	 */
	lock: { timeoutMs: number; snapshotKeep: number };
	dream: {
		nudgeAfterSessions: number;
		nudgeAfterHours: number;
		model?: string;
		thinkLevel: ThinkLevel;
		sessionPersistence?: SessionPersistenceConfig;
	};
	sessionSearch: { maxSessions: number; maxMatches: number };
	autoSurfacing: AutoSurfacingConfig & {
		sessionPersistence?: SessionPersistenceConfig;
	};
	extractMemories: ExtractMemoriesConfig & {
		sessionPersistence?: SessionPersistenceConfig;
	};
}

export const DEFAULT_CONFIG: MemoryConfig = {
	// headless 子会话默认只在内存里跑：extract / dream / 侧查询都不该往用户的 sessions 目录里落盘。
	// **没有模型默认值**：model 必须由用户显式配置（defaults.model 或 per-task），否则 session_start 报错。
	defaults: { sessionPersistence: { enabled: false } },
	memoryDir: join(homedir(), CONFIG_DIR_NAME, "memory"),
	memIndexMaxLines: 200,
	memIndexMaxBytes: 25600,
	// 注入口径独立于写入口径（v2.3.0 起）：窗口只取索引**最新**的 50 行。
	// 16384 B ≈ 50 条中文索引行的实测上界（本机样本 221–321 B/行），保证「行数」才是真正生效的上限。
	memIndexInjectMaxLines: 50,
	memIndexInjectMaxBytes: 16384,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
	dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, thinkLevel: "high" },
	sessionSearch: { maxSessions: 10, maxMatches: 5 },
	autoSurfacing: {
		enabled: true,
		thinkLevel: "off",
		maxFiles: 3,
		maxEntryBytes: 3072,
		maxInjectionBytes: 10240,
	},
	extractMemories: {
		// 每轮结束都要跑一次 headless 模型调用，代价必须由用户显式承担：默认关闭。
		enabled: false,
		thinkLevel: "high",
		maxContextTokens: 2000,
		maxToolResultChars: 500,
		maxAssistantChars: 2000,
	},
};

/** 需要显式模型的子任务。顺序固定：dream → extractMemories → autoSurfacing（校验信息按此顺序输出）。 */
export type ModelTask = "dream" | "extractMemories" | "autoSurfacing";

/** 某任务的模型值：per-task 优先，其次共享的 defaults.model。`/memory` 的模块状态行也用它。 */
export function taskModel(cfg: MemoryConfig, task: ModelTask): string | undefined {
	// `?.`：`deepMerge` 把用户写的 `"dream": null` 原样带进来 —— 那时应该报「没有模型」，
	// 而不是抛 TypeError，把启动校验变成一句看不懂的初始化失败。
	return cfg[task]?.model ?? cfg.defaults?.model;
}

/** 会执行的任务及其模型值。dream 恒在执行集合内（没有包级开关可以让它不跑）。 */
export function requiredModels(cfg: MemoryConfig): Array<{ task: ModelTask; value: string | undefined }> {
	const out: Array<{ task: ModelTask; value: string | undefined }> = [
		{ task: "dream", value: taskModel(cfg, "dream") },
	];
	if (cfg.extractMemories.enabled) out.push({ task: "extractMemories", value: taskModel(cfg, "extractMemories") });
	if (cfg.autoSurfacing.enabled) out.push({ task: "autoSurfacing", value: taskModel(cfg, "autoSurfacing") });
	return out;
}

/**
 * 启动校验：空数组 = 通过。
 * `resolve` 由调用方注入（生产时是 `(v) => resolveModel(v, ctx.modelRegistry) !== undefined`），
 * 因此本函数不依赖 SDK 的 registry 类型，可用假 resolve 单测。
 */
export function modelConfigErrors(cfg: MemoryConfig, resolve: (value: string) => boolean): string[] {
	const errors: string[] = [];
	for (const { task, value } of requiredModels(cfg)) {
		if (value === undefined) {
			errors.push(`no model for ${task} — set "${task}.model" or "defaults.model" in memory.json`);
		} else if (!resolve(value)) {
			errors.push(`model "${value}" for ${task} is not resolvable (unknown id or missing credentials)`);
		}
	}
	return errors;
}

/** 已通过启动校验的模型值；缺失时抛错（真正的守卫在 session_start，这里是防御）。 */
export function requiredModel(cfg: MemoryConfig, task: ModelTask): string {
	const value = taskModel(cfg, task);
	if (value === undefined) {
		throw new Error(`no model for ${task} — set "${task}.model" or "defaults.model" in memory.json`);
	}
	return value;
}

function expandTilde(p: string, platform: NodeJS.Platform = process.platform): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	// `~\` 只在 Windows 上展开：POSIX 上 `~\foo` 是以 `~` 开头的合法文件名，
	// 改写它会破坏用户真实的路径（spec Ruling 4）。
	if (platform === "win32" && p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return p;
}

function deepMerge<T>(base: T, over: Partial<T>): T {
	// biome-ignore lint/suspicious/noExplicitAny: generic deep merge
	const out: any = { ...base };
	for (const k of Object.keys(over) as (keyof T)[]) {
		// biome-ignore lint/suspicious/noExplicitAny: generic deep merge
		const ov = over[k] as any;
		// biome-ignore lint/suspicious/noExplicitAny: generic deep merge
		if (ov && typeof ov === "object" && !Array.isArray(ov) && typeof (out as any)[k] === "object") {
			// biome-ignore lint/suspicious/noExplicitAny: generic deep merge
			(out as any)[k] = deepMerge((out as any)[k], ov);
		} else if (ov !== undefined) {
			// biome-ignore lint/suspicious/noExplicitAny: generic deep merge
			(out as any)[k] = ov;
		}
	}
	return out;
}

function readJsonSafe(path: string): Partial<MemoryConfig> {
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")) as Partial<MemoryConfig>;
	} catch {
		// ignore malformed
	}
	return {};
}

export interface LoadConfigContext {
	cwd: string;
	isProjectTrusted(): boolean;
	_globalDir?: string;
	_configDirName?: string;
	/** 测试注入缝：命名/展开规则跟随的平台。默认 `process.platform`。 */
	_platform?: NodeJS.Platform;
}

export async function loadConfig(ctx: LoadConfigContext): Promise<MemoryConfig> {
	const agentDir = ctx._globalDir ?? getAgentDir();
	const configDirName = ctx._configDirName ?? CONFIG_DIR_NAME;
	let cfg: MemoryConfig = { ...DEFAULT_CONFIG };

	const globalFile = join(agentDir, "memory.json");
	cfg = deepMerge(cfg, readJsonSafe(globalFile));

	if (ctx.isProjectTrusted()) {
		const projectFile = join(ctx.cwd, configDirName, "memory.json");
		cfg = deepMerge(cfg, readJsonSafe(projectFile));
	}

	cfg.memoryDir = expandTilde(cfg.memoryDir, ctx._platform ?? process.platform);
	return cfg;
}
