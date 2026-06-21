import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CodingToolsConfig } from "./config";

export function enableSearchTools(pi: ExtensionAPI, config: CodingToolsConfig): void {
	const allTools = new Set(pi.getAllTools().map((t) => t.name));
	const current = new Set(pi.getActiveTools());
	const desired = [
		{ name: "ls", enabled: config.ls },
		{ name: "find", enabled: config.find },
		{ name: "grep", enabled: config.grep },
	] as const;
	for (const { name, enabled } of desired) {
		if (enabled && allTools.has(name) && !current.has(name)) {
			current.add(name);
		}
	}
	pi.setActiveTools([...current]);
}
