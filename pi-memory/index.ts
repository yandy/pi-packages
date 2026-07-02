import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config";
import { resolveMemoryDir } from "./src/paths";
import { loadIndexSnapshot, buildInjection } from "./src/inject";

export default function (pi: ExtensionAPI) {
	let memoryDir: string | null = null;
	let indexSnapshot = "";
	let enabled = true;

	pi.on("session_start", async (_event, ctx) => {
		const config = await loadConfig(ctx);
		enabled = config.enabled;
		if (!enabled) return;
		memoryDir = await resolveMemoryDir(config, ctx.cwd);
		indexSnapshot = await loadIndexSnapshot(memoryDir, config.memIndexMaxLines, config.memIndexMaxBytes);
		// nudge + tool/command registration added in later tasks
	});

	pi.on("before_agent_start", async (event) => {
		if (!enabled || !indexSnapshot) return;
		return { systemPrompt: buildInjection(event.systemPrompt, indexSnapshot) };
	});
}
