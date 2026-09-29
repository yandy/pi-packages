import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSandboxConfig } from "./src/config";
import { createPermissionCommand, createPermissionState } from "./src/permission";
import { canonicalPath } from "./src/policy";
import { selectRunner } from "./src/runners";
import { createSandboxTools } from "./src/tools";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const config = loadSandboxConfig(cwd);
	const permission = createPermissionState();
	const workspaceRoot = canonicalPath(cwd);

	const tools = createSandboxTools({ cwd, workspaceRoot, getConfig: () => config, permission });
	pi.registerTool(tools.bash as never);
	pi.registerTool(tools.write as never);
	pi.registerTool(tools.edit as never);

	pi.registerCommand("permission", createPermissionCommand({
		state: permission,
		describeStatus: () => {
			const effective = permission.override ?? config.mode;
			const source = permission.override !== null ? "/permission override" : "config default";
			let runnerText: string;
			if (effective === "danger-full-access") {
				runnerText = "bypassed (danger-full-access)";
			} else {
				const selected = selectRunner(config.probeTimeoutMs);
				runnerText = selected.runner === "unavailable"
					? "unavailable (fail-closed: confined commands will be refused)"
					: `${selected.runner} (${selected.enforcement} enforcement)`;
			}
			return [
				`sandbox mode: ${effective} (${source})`,
				`runner: ${runnerText}`,
				`workspace: ${workspaceRoot}`,
			].join("\n");
		},
	}));
}
