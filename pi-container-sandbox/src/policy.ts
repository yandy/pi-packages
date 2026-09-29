import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * 文件效果策略三档（spec §4）。read-only 是底线：任何提权都不以它为目标。
 */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ConfinedSandboxMode = Exclude<SandboxMode, "danger-full-access">;

export const SANDBOX_MODES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

export function isSandboxMode(value: unknown): value is SandboxMode {
	return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value);
}

/**
 * 把授予根解析到强制层实际比较的路径（symlink 已解）；解析失败保留原拼写——
 * 不存在的根匹配不到任何路径，是保守结果（与 deepseek roots.ts 一致）。
 */
export function canonicalPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/**
 * workspace-write = workspace + /tmp + os.tmpdir()（canonical、去重）；read-only 为空。
 * seatbelt profile 与 fs 围栏共用此推导，防止语义漂移（spec §4）。
 */
export function writableRoots(mode: SandboxMode, workspaceRoot: string): string[] {
	if (mode !== "workspace-write") return [];
	return [...new Set([workspaceRoot, "/tmp", tmpdir()].map(canonicalPath))];
}

/**
 * 每次工具调用解析生效模式：进程级 /permission 覆盖 > 配置默认。
 * （已批准的 escalation 只作用于单次调用，在 tools 层单独处理，spec §4。）
 */
export function resolveEffectiveMode(userOverride: SandboxMode | null, configDefault: SandboxMode): SandboxMode {
	return userOverride ?? configDefault;
}
