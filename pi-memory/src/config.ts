import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface MemoryConfig {
	enabled: boolean;
	memoryDir: string;
	memIndexMaxLines: number;
	memIndexMaxBytes: number;
	dream: { nudgeAfterSessions: number; nudgeAfterHours: number; model: string };
	sessionSearch: { maxSessions: number; maxMatches: number };
}

export const DEFAULT_CONFIG: MemoryConfig = {
	enabled: true,
	memoryDir: join(homedir(), CONFIG_DIR_NAME, "memory"),
	memIndexMaxLines: 200,
	memIndexMaxBytes: 25600,
	dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, model: "auto" },
	sessionSearch: { maxSessions: 10, maxMatches: 5 },
};

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function deepMerge<T>(base: T, over: Partial<T>): T {
	const out: any = { ...base };
	for (const k of Object.keys(over) as (keyof T)[]) {
		const ov = over[k] as any;
		if (ov && typeof ov === "object" && !Array.isArray(ov) && typeof (out as any)[k] === "object") {
			(out as any)[k] = deepMerge((out as any)[k], ov);
		} else if (ov !== undefined) {
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

	const globalFile = join(agentDir, "pi-memory.json");
	cfg = deepMerge(cfg, readJsonSafe(globalFile));

	if (ctx.isProjectTrusted()) {
		const projectFile = join(ctx.cwd, configDirName, "pi-memory.json");
		cfg = deepMerge(cfg, readJsonSafe(projectFile));
	}

	cfg.memoryDir = expandTilde(cfg.memoryDir);
	return cfg;
}
