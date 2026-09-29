import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSandboxConfig } from "./src/config";
import { createPermissionCommand, processPermissionState } from "./src/permission";
import { canonicalPath } from "./src/policy";
import { selectRunner } from "./src/runners";
import { createSandboxTools } from "./src/tools";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	// I2 fail-safe：坏配置在此 warn 并回落 DEFAULT（仍是受约束的 workspace-write），
	// 绝不 throw——throw 会让 pi 把整个扩展置 null，三个基础工具随即无沙箱裸跑（fail-open）。
	getSandboxConfig(cwd);

	// C1：/permission 覆盖用进程级模块单例（spec §9）——pi 对每个会话（含 subagent 子会话）
	// 重新调用本 factory，activate 闭包不跨会话共享；模块单例才能覆盖父/子全部会话。
	const tools = createSandboxTools({ cwd, permission: processPermissionState });
	pi.registerTool(tools.bash as never);
	pi.registerTool(tools.write as never);
	pi.registerTool(tools.edit as never);

	pi.registerCommand("permission", createPermissionCommand({
		state: processPermissionState,
		// C2：pi 从不 chdir，会话 cwd 只经命令 ctx.cwd 可达；空串回落 activate 时 cwd。
		describeStatus: (statusCwd) => {
			const effectiveCwd = statusCwd || cwd;
			const cfg = getSandboxConfig(effectiveCwd);
			const effective = processPermissionState.override ?? cfg.mode;
			const source = processPermissionState.override !== null ? "/permission override" : "config default";
			let runnerText: string;
			if (cfg.runnerCommand !== null && cfg.runnerCommand.length > 0) {
				runnerText = `custom command (${cfg.runnerCommand.join(" ")})`;
			} else if (effective === "danger-full-access") {
				runnerText = "bypassed (danger-full-access)";
			} else {
				const selected = selectRunner(cfg.probeTimeoutMs);
				runnerText = selected.runner === "unavailable"
					? "unavailable (fail-closed: confined commands will be refused)"
					: `${selected.runner} (${selected.enforcement} enforcement)`;
			}
			return [
				`sandbox mode: ${effective} (${source})`,
				`runner: ${runnerText}`,
				`workspace: ${canonicalPath(effectiveCwd)}`,
			].join("\n");
		},
	}));
}
