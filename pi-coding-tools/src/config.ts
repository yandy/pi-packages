import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ServerOverride {
	command?: string[];
	disabled?: boolean;
	env?: Record<string, string>;
}

export interface LspConfig {
	disabled?: boolean;
	servers?: Record<string, ServerOverride>;
}

export interface CodingToolsConfig {
	ls: boolean;
	find: boolean;
	grep: boolean;
	ast_grep_search: boolean;
	lsp_symbols: boolean;
	lsp_hover: boolean;
	lsp_navigate: boolean;
	lsp?: LspConfig;
}

const DEFAULT_CONFIG: CodingToolsConfig = {
	ls: true,
	find: true,
	grep: true,
	ast_grep_search: true,
	lsp_symbols: true,
	lsp_hover: true,
	lsp_navigate: true,
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
		ls: projectConfig.ls ?? globalConfig.ls ?? DEFAULT_CONFIG.ls,
		find: projectConfig.find ?? globalConfig.find ?? DEFAULT_CONFIG.find,
		grep: projectConfig.grep ?? globalConfig.grep ?? DEFAULT_CONFIG.grep,
		ast_grep_search: projectConfig.ast_grep_search ?? globalConfig.ast_grep_search ?? DEFAULT_CONFIG.ast_grep_search,
		lsp_symbols: projectConfig.lsp_symbols ?? globalConfig.lsp_symbols ?? DEFAULT_CONFIG.lsp_symbols,
		lsp_hover: projectConfig.lsp_hover ?? globalConfig.lsp_hover ?? DEFAULT_CONFIG.lsp_hover,
		lsp_navigate: projectConfig.lsp_navigate ?? globalConfig.lsp_navigate ?? DEFAULT_CONFIG.lsp_navigate,
		lsp: projectConfig.lsp ?? globalConfig.lsp ?? DEFAULT_CONFIG.lsp,
	};
	cachedCwd = dir;
	return cachedConfig;
}
