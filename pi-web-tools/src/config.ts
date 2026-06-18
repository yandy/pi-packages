import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface WebToolsConfig {
	aliyun?: {
		baseUrl?: string;
		searchModel?: string;
	};
}

let cachedConfig: WebToolsConfig | null = null;
let cachedCwd: string | null = null;

export function loadConfig(cwd?: string): WebToolsConfig {
	const dir = cwd || process.cwd();
	if (cachedConfig && cachedCwd === dir) return cachedConfig;

	try {
		const path = resolve(dir, ".pi/agent/web-tools.json");
		const raw = readFileSync(path, "utf-8");
		cachedConfig = JSON.parse(raw) as WebToolsConfig;
		cachedCwd = dir;
		return cachedConfig;
	} catch {
		cachedConfig = {};
		cachedCwd = dir;
		return cachedConfig;
	}
}

export function resolveSetting(
	value: string | undefined,
	configValue: string | undefined,
	defaultValue: string,
): string {
	return value || configValue || defaultValue;
}
