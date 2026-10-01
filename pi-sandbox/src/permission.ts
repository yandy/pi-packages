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

/** 进程全局槽位键：带包名前缀，避免与其他扩展的 globalThis 使用相撞。 */
const PERMISSION_STATE_KEY = Symbol.for("@yandy0725/pi-sandbox:permission-state");

function getOrCreatePermissionState(): PermissionState {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[PERMISSION_STATE_KEY] as PermissionState | undefined;
	if (existing !== undefined) return existing;
	const state = createPermissionState();
	store[PERMISSION_STATE_KEY] = state;
	return state;
}

/**
 * 进程级单例（spec §9），必须挂 **globalThis** 而不是模块级变量：宿主的扩展模块缓存以
 * (cwd, generation) 为令牌（`dist/core/extensions/loader.js` 的 `useExtensionCacheCwd` /
 * `loadExtensionModule`），令牌变化即 `clearExtensionCache()` + `createJiti({ moduleCache: false })`
 * 重新 import 整个扩展——pi-subagents 的子会话 cwd 为 `params.cwd ?? snapshot.cwd`（可与父不同），
 * `/reload` 也会清缓存。模块级变量在这些情形下会重新初始化成 `{ override: null }`，父会话设的
 * `/permission` 覆盖对子会话（或 reload 后的新实例）不可见：表现为"我明明放宽了，它还是被拒"。
 * globalThis 槽位在同进程内被所有模块实例共享，因此先设/后设、同 cwd/异 cwd 都能看到同一份状态。
 */
export const processPermissionState: PermissionState = getOrCreatePermissionState();

/** 仅供测试复位全局槽位（生产代码不得调用）。 */
export function resetPermissionStateForTests(): void {
	delete (globalThis as Record<symbol, unknown>)[PERMISSION_STATE_KEY];
}

export interface PermissionCommandDeps {
	state: PermissionState;
	/** 生成状态块：effective mode 及来源、选中 runner 与 enforcement、workspace root。
	 *  cwd 为发起命令的会话 cwd（C2：pi 从不 chdir，只经 ctx.cwd 可达）；空串表示未知。 */
	describeStatus: (cwd: string) => string;
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
		handler: async (args: string, ctx: { ui: NotifyUI; cwd?: string }) => {
			const arg = args.trim();
			if (!arg) {
				ctx.ui.notify(deps.describeStatus(ctx.cwd ?? ""), "info");
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
