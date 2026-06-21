import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface CodingToolsConfig {
	applyPatch: boolean;
	ls: boolean;
	find: boolean;
	grep: boolean;
}

const DEFAULT_CONFIG: CodingToolsConfig = {
	applyPatch: true,
	ls: true,
	find: true,
	grep: true,
};

let cachedConfig: CodingToolsConfig | null = null;
let cachedCwd: string | null = null;

function readJsonFile(path: string): Partial<CodingToolsConfig> | null {
	try {
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as Partial<CodingToolsConfig>;
	} catch {
		return null;
	}
}

export function loadConfig(cwd?: string): CodingToolsConfig {
	const dir = cwd || process.cwd();
	if (cachedConfig && cachedCwd === dir) return cachedConfig;

	const agentDir = getAgentDir();
	const globalConfig = readJsonFile(resolve(agentDir, "coding-tools.json")) || {};
	const projectConfig = readJsonFile(resolve(dir, CONFIG_DIR_NAME, "coding-tools.json")) || {};

	cachedConfig = {
		applyPatch: projectConfig.applyPatch ?? globalConfig.applyPatch ?? DEFAULT_CONFIG.applyPatch,
		ls: projectConfig.ls ?? globalConfig.ls ?? DEFAULT_CONFIG.ls,
		find: projectConfig.find ?? globalConfig.find ?? DEFAULT_CONFIG.find,
		grep: projectConfig.grep ?? globalConfig.grep ?? DEFAULT_CONFIG.grep,
	};
	cachedCwd = dir;
	return cachedConfig;
}
