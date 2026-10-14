import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix as posixPath, resolve as resolvePath, win32 as win32Path } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isWithinRoots } from "./fence";
import { canonicalPath, isSandboxMode, type SandboxMode } from "./policy";

/** sandbox.json schema v3（spec 2026-10-14 §4）。1.x 的 image/runtime/host 组已删除。 */
export interface SandboxConfig {
	mode: SandboxMode;
	/** 运维覆盖：自定义 bwrap 兼容 runner argv；必须与 runnerFailureSignatures 成对。 */
	runnerCommand: string[] | null;
	runnerFailureSignatures: string[] | null;
	/** 每个功能探测的超时；必须为正有限数（0 对 Node 意味着无超时）。 */
	probeTimeoutMs: number;
	/**
	 * 额外可写根（超出 workspace + tmp）；仅 workspace-write 下生效。
	 * 写的是**原始配置字符串**（可带 `~`），由 resolveConfiguredRoots 解析后才成为授予根。
	 * 合并语义与其他字段完全一致（项目 > 全局 > 默认），见 README 的风险说明。
	 */
	writableRoots: string[];
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
	mode: "workspace-write",
	runnerCommand: null,
	runnerFailureSignatures: null,
	probeTimeoutMs: 5000,
	writableRoots: [],
};

const LEGACY_GROUPS = ["image", "runtime", "host"] as const;

export function getSandboxConfigPath(hostCwd: string): string {
	return resolvePath(hostCwd, CONFIG_DIR_NAME, "sandbox.json");
}

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

	// 结构性错误 throw（与 runnerCommand 同口径）：getSandboxConfig 的 fail-safe 会回落整份默认并 warn。
	// 单条条目的问题（相对路径、危险根、不存在）不在这里 throw，而是 resolveConfiguredRoots 里
	// warn + 丢弃——一条写错的条目不该把用户整份配置打回默认。
	const writableRoots = raw.writableRoots ?? DEFAULT_SANDBOX_CONFIG.writableRoots;
	if (!isStringArray(writableRoots)) {
		throw new Error(`sandbox: ${source}: writableRoots must be a string array`);
	}

	return {
		mode,
		runnerCommand: runnerCommand as string[] | null,
		runnerFailureSignatures: runnerFailureSignatures as string[] | null,
		probeTimeoutMs,
		writableRoots: [...writableRoots],
	};
}

export function loadSandboxConfig(hostCwd: string): SandboxConfig {
	const globalPath = resolvePath(getAgentDir(), "sandbox.json");
	const projectPath = getSandboxConfigPath(hostCwd);
	const globalRaw = readJsonFile(globalPath) ?? {};
	const projectRaw = readJsonFile(projectPath) ?? {};

	for (const [raw, path] of [[globalRaw, globalPath], [projectRaw, projectPath]] as const) {
		for (const key of LEGACY_GROUPS) {
			if (key in raw) console.warn(`sandbox: ignoring legacy "${key}" section in ${path} (removed in 2.0; see README migration notes)`);
		}
	}

	// 逐字段合并：项目 > 全局 > 默认（所有字段一致，writableRoots 不做例外）
	const merged: Record<string, unknown> = {};
	for (const key of Object.keys(DEFAULT_SANDBOX_CONFIG)) {
		const value = projectRaw[key] ?? globalRaw[key];
		if (value !== undefined) merged[key] = value;
	}
	return validateSandboxConfig(merged, "sandbox.json");
}

const configCache = new Map<string, SandboxConfig>();

/** 安全加载（fail-safe，I2）：任何加载/校验错误回落默认配置（仍是受约束的 workspace-write），按 cwd 缓存。 */
export function getSandboxConfig(hostCwd: string): SandboxConfig {
	let cached = configCache.get(hostCwd);
	if (!cached) {
		try {
			cached = loadSandboxConfig(hostCwd);
		} catch (err) {
			console.warn(`sandbox: failed to load config, falling back to defaults (mode "${DEFAULT_SANDBOX_CONFIG.mode}"): ${err instanceof Error ? err.message : String(err)}`);
			cached = DEFAULT_SANDBOX_CONFIG;
		}
		configCache.set(hostCwd, cached);
	}
	return cached;
}

export function resetSandboxConfigCache(): void {
	configCache.clear();
}

/**
 * 额外可写根的解析告警去重：配置按 cwd 缓存、解析按工具调用发生，
 * 不去重会每条命令刷一次同样的 warn。
 */
const configuredRootWarnings = new Set<string>();

/** 仅供测试复位告警去重集（生产代码不得调用）。 */
export function resetConfiguredRootsWarningsForTests(): void {
	configuredRootWarnings.clear();
}

/** resolveConfiguredRoots 的测试注入点（testing.md「参数注入」）；生产全部不传。 */
export interface ConfiguredRootsHooks {
	/** 缺省 os.homedir()。 */
	homeDir?: string;
	/** 缺省 getAgentDir()（取不到则跳过该条危险根规则）；显式 null = 模拟取不到。 */
	agentDir?: string | null;
	/** 缺省 node:fs existsSync。 */
	exists?: (path: string) => boolean;
	/** 缺省 console.warn（经去重集）。 */
	warn?: (message: string) => void;
	/** 围栏比较是否大小写敏感；缺省按（可注入的）platform 推导，与 fence 同口径。 */
	caseSensitive?: boolean;
	/** 缺省 process.platform。**路径语义跟着它走**（isAbsolute / join / sep 取 path.win32 或 path.posix），
	 *  否则注入 platform 的测试在 POSIX 宿主上走不到 win32 分支；win32 时额外公告 runner 侧不支持。 */
	platform?: string;
}

/**
 * win32 上“真正固定”的绝对路径：带盘符（`C:\…` / `C:/…`）或 UNC 前缀（`\\server\share`）。
 * 光靠 `path.isAbsolute` 不够：它在 win32 上对 `/foo` 与裸 `/` 也返回 true，而两者都是
 * **盘符相对**的（含义 = “当前盘”），`realpathSync.native("/")` 按进程 cwd 所在盘解析。
 */
const WINDOWS_EXPLICIT_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\)/u;

/**
 * `~` 展开：只认 `~` 与 `~/…`（win32 也认 `~\…`）。
 * **不**展开 `$HOME` / `%USERPROFILE%`：“谁的环境”会成为隐式输入，而配置是按 cwd 跨会话缓存的。
 * `~user/…` 也不展开（不查 passwd），会按相对路径被丢弃。
 */
function expandHome(entry: string, homeDir: string, pathImpl: typeof posixPath): string {
	if (entry === "~") return homeDir;
	if (entry.startsWith("~/")) return pathImpl.join(homeDir, entry.slice(2));
	if (pathImpl.sep === "\\" && entry.startsWith("~\\")) return pathImpl.join(homeDir, entry.slice(2));
	return entry;
}

function defaultAgentDir(): string | null {
	try {
		return getAgentDir();
	} catch {
		return null;
	}
}

/**
 * 把配置里的 `writableRoots` 解析成生效的授予根（spec 2026-10-14 §4.3）。
 *
 * 每步失败都是 **warn + 丢弃该条**，不 throw：
 * 1. `~` 展开；
 * 2. 必须绝对路径（裸盘符 `C:` 与盘符相对路径 `C:work` 在 path.win32 下本就不是 absolute，自然被丢）；
 * 3. win32 额外要求盘符或 UNC 前缀：`/foo` 与裸 `/` 的 isAbsolute 为 true 但含义随进程 cwd 所在盘
 *    漂移（同 fence.ts 对 DRIVE_RELATIVE_PATH 的口径）；
 * 4. 危险根拒绝：等于或包含 homedir（含 `/`、`/home`、`/Users` 这些祖先）或 pi 的 agentDir。
 *    包含判定用 fence 的 isWithinRoots 口径（分隔符边界 + 平台大小写敏感性 + dev/ino 身份回退），
 *    避免 `C:\work` 命中 `C:\workshop`；
 * 5. 存在性过滤：bwrap 的 `--bind <src> <src>` 对不存在的 src 硬失败，landlock 授权与 win32 的 ACL
 *    授权同理；若只让围栏放行而 runner 跳过，就会出现“write 工具说可以、bash 说 EROFS”的漂移，
 *    而 pi 的 write 工具会 mkdir -p 父目录——那等于围栏侧真的在 workspace 外创建了目录（fail-open）。
 *    故**围栏与四个 runner 必须用同一份过滤后的列表**；沙箱也不因为“解析配置”就在文件系统上产生副作用；
 * 6. canonical + 去重。
 *
 * 每次工具调用重新解析（不缓存）：目录可能稍后才被创建，按调用重算能自然拾到。
 */
export function resolveConfiguredRoots(raw: readonly string[], hooks: ConfiguredRootsHooks = {}): string[] {
	const platform = hooks.platform ?? process.platform;
	if (raw.length === 0) return [];
	// 路径语义跟着 platform 走，而不是跟着宿主走：否则注入 platform 的测试（与任何跨平台推导）
	// 会拿到宿主的 isAbsolute/join/sep，win32 的盘符拼写在 POSIX 宿主上根本走不到 win32 分支。
	// 生产不传 platform，此处即 process.platform，行为与直接用 node:path 的默认导出一致。
	const pathImpl = platform === "win32" ? win32Path : posixPath;
	const homeDir = canonicalPath(hooks.homeDir ?? homedir());
	const agentDir = hooks.agentDir !== undefined ? hooks.agentDir : defaultAgentDir();
	const exists = hooks.exists ?? existsSync;
	const caseSensitive = hooks.caseSensitive ?? platform !== "win32";
	const warn = hooks.warn ?? ((message: string) => console.warn(message));
	const warnOnce = (key: string, message: string) => {
		if (configuredRootWarnings.has(key)) return;
		configuredRootWarnings.add(key);
		warn(message);
	};

	const resolved: string[] = [];
	for (const entry of raw) {
		const drop = (reason: string) =>
			warnOnce(
				`${entry}\u0000${reason}`,
				`sandbox: writableRoots entry ${JSON.stringify(entry)} ignored: ${reason}`,
			);
		const trimmed = entry.trim();
		if (trimmed.length === 0) {
			drop("it is empty");
			continue;
		}
		const expanded = expandHome(trimmed, homeDir, pathImpl);
		if (!pathImpl.isAbsolute(expanded)) {
			drop("it is not an absolute path (only absolute paths and `~` are accepted)");
			continue;
		}
		// win32：`/foo` 与裸 `/` 是盘符相对路径，isAbsolute 为 true 但含义随进程 cwd 所在盘漂移。
		// fence.ts 对同类歧义拼写一律“视为不在任何授予根内”，这里同口径拒绝。不拒的后果是
		// fail-open：一条 `"/"` 在 cwd 位于 D: 时解析成 `D:\`，而危险根检查因为 homeDir 在 C:
		// 根本命中不了，整个 D: 盘就被授予可写（CI windows-latest 实测捕获）。
		if (platform === "win32" && !WINDOWS_EXPLICIT_ROOT.test(expanded)) {
			drop(
				"on Windows it must carry a drive letter or a UNC prefix — a bare \"/…\" is drive-relative and drifts with the process working directory",
			);
			continue;
		}
		const canonical = canonicalPath(expanded);
		if (homeDir.length > 0 && isWithinRoots(homeDir, [canonical], caseSensitive)) {
			drop("it is or contains your home directory — that would defeat the sandbox");
			continue;
		}
		if (agentDir !== null && agentDir.length > 0 && isWithinRoots(canonicalPath(agentDir), [canonical], caseSensitive)) {
			drop("it is or contains pi's agent directory — the sandbox must not be able to rewrite pi's own config");
			continue;
		}
		if (!exists(canonical)) {
			drop(
				"it does not exist — the runners cannot grant a missing path (create the directory first, then it takes effect)",
			);
			continue;
		}
		if (!resolved.includes(canonical)) resolved.push(canonical);
	}

	// Ruling 5：win32 的 windows-acl runner 是写死的两根 argv 契约（--workspace / --temp），
	// 本期不支持 N 根。围栏（write/edit）全平台生效，所以这里是不对称的——向 fail-closed 方向（bash 更窄），
	// 但必须显式公告，不能静默。
	if (resolved.length > 0 && platform === "win32") {
		warnOnce(
			"win32-runner-ignores-extra-roots",
			`sandbox: writableRoots (${resolved.length} root(s)) apply to the write/edit tools on Windows, but the windows-acl runner still confines powershell to the workspace + %TEMP% only`,
		);
	}
	return resolved;
}
