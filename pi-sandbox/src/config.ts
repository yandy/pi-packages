import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSandboxMode, type SandboxMode } from "./policy";

/** sandbox.json schema v2（spec §5）。1.x 的 image/runtime/host 组已删除。 */
export interface SandboxConfig {
	mode: SandboxMode;
	/** 运维覆盖：自定义 bwrap 兼容 runner argv；必须与 runnerFailureSignatures 成对。 */
	runnerCommand: string[] | null;
	runnerFailureSignatures: string[] | null;
	/** 每个功能探测的超时；必须为正有限数（0 对 Node 意味着无超时）。 */
	probeTimeoutMs: number;
	/** workspace-write 下额外可写目录；来源是独立的 `sandbox-writable.json`（已 ~ 展开 + realpath 规范化 + 去重）。 */
	extraWritableDirs: string[];
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
	mode: "workspace-write",
	runnerCommand: null,
	runnerFailureSignatures: null,
	probeTimeoutMs: 5000,
	extraWritableDirs: [],
};

const LEGACY_GROUPS = ["image", "runtime", "host"] as const;

function readJsonFile(path: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		// I2：非 null 对象的 JSON（数组/数字/字符串/布尔）一律按 corrupt 处理
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** 校验并规范化一份合并后的原始配置；非法即 throw（source 用于报错定位）。 */
export function validateSandboxConfig(raw: Record<string, unknown>, source: string): SandboxConfig {
	let mode: SandboxMode = DEFAULT_SANDBOX_CONFIG.mode;
	if (raw.mode !== undefined) {
		if (isSandboxMode(raw.mode)) mode = raw.mode;
		else console.warn(`sandbox: invalid mode ${JSON.stringify(raw.mode)} in ${source}, falling back to "${DEFAULT_SANDBOX_CONFIG.mode}"`);
	}

	const runnerCommand = raw.runnerCommand ?? null;
	const runnerFailureSignatures = raw.runnerFailureSignatures ?? null;
	if ((runnerCommand === null) !== (runnerFailureSignatures === null)) {
		throw new Error(`sandbox: ${source}: runnerCommand and runnerFailureSignatures must be configured together`);
	}
	if (runnerCommand !== null && !isStringArray(runnerCommand)) {
		throw new Error(`sandbox: ${source}: runnerCommand must be a string array`);
	}
	if (runnerFailureSignatures !== null) {
		if (!isStringArray(runnerFailureSignatures)) {
			throw new Error(`sandbox: ${source}: runnerFailureSignatures must be a string array`);
		}
		for (const signature of runnerFailureSignatures) {
			if (signature.trim().length === 0 || /[\r\n]/u.test(signature)) {
				throw new Error(`sandbox: ${source}: runnerFailureSignatures entries must be non-empty single-line strings`);
			}
		}
	}

	const probeTimeoutMs = raw.probeTimeoutMs ?? DEFAULT_SANDBOX_CONFIG.probeTimeoutMs;
	if (typeof probeTimeoutMs !== "number" || !Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) {
		throw new Error(`sandbox: ${source}: probeTimeoutMs must be a positive finite number`);
	}

	return {
		mode,
		runnerCommand: runnerCommand as string[] | null,
		runnerFailureSignatures: runnerFailureSignatures as string[] | null,
		probeTimeoutMs,
		// 该字段已迁出 sandbox.json，由 loadWritableDirs() 另行提供（loadSandboxConfig 里合并）
		extraWritableDirs: [],
	};
}

/** `~` / `~/…` / win32 `~\…` → 家目录；不支持 `~user`，其余原样返回。 */
function expandHome(entry: string): string {
	if (entry === "~") return homedir();
	if (entry.startsWith("~/") || entry.startsWith("~\\")) return join(homedir(), entry.slice(2));
	return entry;
}

/** 路径前缀判定（分隔符边界）：child 与 root 相同，或位于 root 之下。 */
function isSameOrUnder(child: string, root: string): boolean {
	if (child === root) return true;
	const boundary = root.endsWith(sep) ? root : `${root}${sep}`;
	return child.startsWith(boundary);
}

/** agent 目录的 canonical 形态；目录尚不存在时退回 resolvePath 的绝对形态。 */
function canonicalAgentDir(): string {
	const agentDir = resolvePath(getAgentDir());
	try {
		return realpathSync.native(agentDir);
	} catch {
		return agentDir;
	}
}

/** 逐条语义解析：展开 → 绝对性 → 必须是已存在目录 → realpath → 去重；无效条目告警并丢弃。 */
export function resolveExtraWritableDirs(entries: readonly string[], source: string): string[] {
	const resolved: string[] = [];
	const seen = new Set<string>();
	const agentDir = canonicalAgentDir();
	for (const raw of entries) {
		const expanded = expandHome(raw);
		if (!isAbsolute(expanded)) {
			console.warn(`sandbox: extraWritableDirs entry is not an absolute path: ${JSON.stringify(raw)} in ${source}, ignoring it`);
			continue;
		}
		let canonical: string;
		try {
			if (!statSync(expanded).isDirectory()) throw new Error("not a directory");
			canonical = realpathSync.native(expanded);
		} catch {
			console.warn(`sandbox: extraWritableDirs entry is not an existing directory: ${JSON.stringify(expanded)} in ${source}, ignoring it`);
			continue;
		}
		// 保护 pi 自己的 agent 目录：条目等于/包含/被包含于它时，受限模型可能改写
		// sandbox.json（下次启动即 danger-full-access）、AGENTS.md 或扩展。按仓库的
		// warn-don't-guess 风格只告警、保留该条目，绝不擅自丢弃。
		if (isSameOrUnder(canonical, agentDir) || isSameOrUnder(agentDir, canonical)) {
			console.warn(`sandbox: extraWritableDirs entry ${canonical} covers pi's agent dir (${agentDir}); a confined model could rewrite the sandbox config with it`);
		}
		if (!seen.has(canonical)) {
			seen.add(canonical);
			resolved.push(canonical);
		}
	}
	return resolved;
}

/**
 * 独立授权文件 `~/.pi/agent/sandbox-writable.json`（2026-10-24 决策）：顶层是 JSON 字符串数组，
 * 无根 key，便于手工编辑/脚本追加。缺失与 `[]` 等价且不告警；损坏/非数组/含非字符串元素
 * → 告警 + 空列表（绝不连坐 `sandbox.json` 的校验与 fail-safe）。逐条语义复用
 * `resolveExtraWritableDirs`。
 */
export function loadWritableDirs(): string[] {
	const path = resolvePath(getAgentDir(), "sandbox-writable.json");
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (err) {
		// 缺失（ENOENT/ENOTDIR）= 无授权，静默；其它读失败（EACCES、EISDIR…）用户明明放了文件
		// 却拿不到授权，必须告警，否则是无提示的失败。
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return [];
		console.warn(`sandbox: cannot read ${path} (${code ?? String(err)}), ignoring extra writable dirs`);
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		console.warn(`sandbox: ${path} is not valid JSON, ignoring extra writable dirs`);
		return [];
	}
	if (!isStringArray(parsed)) {
		console.warn(`sandbox: ${path} must be a JSON array of path strings, ignoring extra writable dirs`);
		return [];
	}
	return resolveExtraWritableDirs(parsed, path);
}

/**
 * 只读全局配置 `~/.pi/agent/sandbox.json`（2026-10-14 决策）。项目级 `<cwd>/.pi/sandbox.json`
 * 被**静默忽略**：项目目录对模型可写，把配置层留在那里等于把 mode / runnerCommand 的改写权
 * 交给模型；不解析、不校验、不告警（决策与被否方案见 docs/superpowers/specs/2026-10-14-global-only-config-decision.md）。
 * 额外可写目录读独立的 `sandbox-writable.json`（2026-10-24 决策），项目级同名文件同样静默忽略。
 */
export function loadSandboxConfig(): SandboxConfig {
	const globalPath = resolvePath(getAgentDir(), "sandbox.json");
	const globalRaw = readJsonFile(globalPath) ?? {};

	for (const key of LEGACY_GROUPS) {
		if (key in globalRaw) console.warn(`sandbox: ignoring legacy "${key}" section in ${globalPath} (removed in 2.0; see README migration notes)`);
	}

	const writablePath = resolvePath(getAgentDir(), "sandbox-writable.json");
	if ("extraWritableDirs" in globalRaw) {
		console.warn(`sandbox: ignoring "extraWritableDirs" in ${globalPath} (moved to ${writablePath}; see README migration notes)`);
	}

	const validated = validateSandboxConfig(globalRaw, globalPath);
	return { ...validated, extraWritableDirs: loadWritableDirs() };
}

let cachedConfig: SandboxConfig | undefined;

/** 安全加载（fail-safe，I2）：任何加载/校验错误回落默认配置（仍是受约束的 workspace-write），进程内缓存一次。 */
export function getSandboxConfig(): SandboxConfig {
	if (cachedConfig === undefined) {
		try {
			cachedConfig = loadSandboxConfig();
		} catch (err) {
			console.warn(`sandbox: failed to load config, falling back to defaults (mode "${DEFAULT_SANDBOX_CONFIG.mode}"): ${err instanceof Error ? err.message : String(err)}`);
			// 失败隔离是双向的：sandbox.json 坏了只回落它自己的字段，额外可写根仍从独立文件取
			// （该文件自身不 throw），绝不让一边的手误吞掉另一边的授权。
			cachedConfig = { ...DEFAULT_SANDBOX_CONFIG, extraWritableDirs: loadWritableDirs() };
		}
	}
	return cachedConfig;
}

export function resetSandboxConfigCache(): void {
	cachedConfig = undefined;
}
