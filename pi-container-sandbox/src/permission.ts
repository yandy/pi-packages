import { isSandboxMode, SANDBOX_MODES, type SandboxMode } from "./policy";

/**
 * 进程级用户覆盖（spec §8/§9）：一个 pi 进程只有一个人类用户，/permission 设置的
 * 覆盖对父会话与所有子会话的下一次工具调用立即生效。这是救活被卡子 agent 的
 * 唯一持久杠杆（子会话 hasUI=false，escalation 一律 fail-closed）。
 */
export interface PermissionState {
	override: SandboxMode | null;
}

export function createPermissionState(): PermissionState {
	return { override: null };
}

export interface PermissionCommandDeps {
	state: PermissionState;
	/** 生成状态块：effective mode 及来源、选中 runner 与 enforcement、workspace root。 */
	describeStatus: () => string;
}

interface NotifyUI {
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export function createPermissionCommand(deps: PermissionCommandDeps) {
	return {
		description: "Show or switch the sandbox permission mode (read-only | workspace-write | danger-full-access), process-wide",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim();
			return SANDBOX_MODES.filter((m) => m.startsWith(prefix)).map((m) => ({ value: m, label: m }));
		},
		handler: async (args: string, ctx: { ui: NotifyUI }) => {
			const arg = args.trim();
			if (!arg) {
				ctx.ui.notify(deps.describeStatus(), "info");
				return;
			}
			if (!isSandboxMode(arg)) {
				ctx.ui.notify(`sandbox: unknown mode "${arg}". Available: ${SANDBOX_MODES.join(", ")}`, "error");
				return;
			}
			deps.state.override = arg;
			ctx.ui.notify(`sandbox: permission mode set to ${arg} (process-wide, effective on the next tool call)`, "info");
		},
	};
}
