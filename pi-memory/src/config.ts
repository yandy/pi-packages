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
	enabled: boolean;
	/** Shared defaults for model and sessionPersistence. Per-task configs override. */
	defaults?: DefaultsConfig;
	memoryDir: string;
	/** Write capacity: max entries in MEMORY.md index. */
	memIndexMaxLines: number;
	/** Write capacity: max bytes of serialized MEMORY.md index. */
	memIndexMaxBytes: number;
	/** Injection truncation: max lines of MEMORY.md injected into system prompt. */
	memIndexInjectMaxLines: number;
	/** Injection truncation: max bytes of MEMORY.md injected into system prompt. */
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
	enabled: true,
	// headless 子会话默认只在内存里跑：extract / dream / 侧查询都不该往用户的 sessions 目录里落盘。
	defaults: { sessionPersistence: { enabled: false } },
	memoryDir: join(homedir(), CONFIG_DIR_NAME, "memory"),
	memIndexMaxLines: 200,
	memIndexMaxBytes: 25600,
	// 注入口径（20 / 3072）在 Plan B 保持不变：改成 200 / 25600 属 D3，与 sections 注入一起在 Plan C 落地。
	memIndexInjectMaxLines: 20,
	memIndexInjectMaxBytes: 3072,
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
		enabled: true,
		thinkLevel: "high",
		maxContextTokens: 2000,
		maxToolResultChars: 500,
		maxAssistantChars: 2000,
	},
};

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
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

	cfg.memoryDir = expandTilde(cfg.memoryDir);
	return cfg;
}
