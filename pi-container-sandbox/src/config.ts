import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSandboxMode, type SandboxMode } from "./policy";

/** sandbox.json schema v2（spec §5）。1.x 的 image/runtime/host 组已删除。 */
export interface SandboxConfig {
	mode: SandboxMode;
	/** 运维覆盖：自定义 bwrap 兼容 runner argv；必须与 runnerFailureSignatures 成对。 */
	runnerCommand: string[] | null;
	runnerFailureSignatures: string[] | null;
	/** 每个功能探测的超时；必须为正有限数（0 对 Node 意味着无超时）。 */
	probeTimeoutMs: number;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
	mode: "workspace-write",
	runnerCommand: null,
	runnerFailureSignatures: null,
	probeTimeoutMs: 5000,
};

const LEGACY_GROUPS = ["image", "runtime", "host"] as const;

export function getSandboxConfigPath(hostCwd: string): string {
	return resolvePath(hostCwd, CONFIG_DIR_NAME, "sandbox.json");
}

function readJsonFile(path: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
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

	// 逐字段合并：项目 > 全局 > 默认
	const merged: Record<string, unknown> = {};
	for (const key of Object.keys(DEFAULT_SANDBOX_CONFIG)) {
		const value = projectRaw[key] ?? globalRaw[key];
		if (value !== undefined) merged[key] = value;
	}
	return validateSandboxConfig(merged, "sandbox.json");
}
