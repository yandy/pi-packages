import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

interface WebToolsConfig {
	websearch?: {
		provider?: string;
	};
	webfetch?: {
		provider?: string;
	};
}

let cachedConfig: WebToolsConfig | null = null;
let cachedCwd: string | null = null;

function readJsonFile(path: string): WebToolsConfig | null {
	try {
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as WebToolsConfig;
	} catch {
		return null;
	}
}

function mergeConfigs(base: WebToolsConfig, override: WebToolsConfig): WebToolsConfig {
	const merged: WebToolsConfig = {};
	for (const section of ["websearch", "webfetch"] as const) {
		if (base[section] || override[section]) {
			merged[section] = {
				...base[section],
				...override[section],
			};
		}
	}
	return merged;
}

export function loadConfig(cwd: string): WebToolsConfig {
	if (cachedConfig && cachedCwd === cwd) return cachedConfig;

	const agentDir = getAgentDir();
	const globalConfig = readJsonFile(resolve(agentDir, "web-tools.json")) || {};
	const projectConfig = readJsonFile(resolve(cwd, CONFIG_DIR_NAME, "web-tools.json")) || {};

	cachedConfig = mergeConfigs(globalConfig, projectConfig);
	cachedCwd = cwd;
	return cachedConfig;
}

const VALID_PROVIDERS: Record<"websearch" | "webfetch", readonly string[]> = {
	websearch: ["exa", "deepseek", "aliyun"],
	webfetch: ["local", "deepseek"],
};

export function resolveProvider(
	tool: "websearch" | "webfetch",
	paramValue: string | undefined,
	config: WebToolsConfig,
): { provider?: string; error?: string } {
	if (paramValue !== undefined) return { provider: paramValue };
	const configured = config[tool]?.provider;
	if (configured === undefined) return {};
	const valid = VALID_PROVIDERS[tool];
	if (!valid.includes(configured)) {
		return {
			error: `Invalid provider "${configured}" for ${tool} in web-tools.json. Expected one of: ${valid.join(", ")}`,
		};
	}
	return { provider: configured };
}

