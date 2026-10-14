import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/**
 * protected.ts — 可写根**内部**的只读挖洞（deny-within-allow）。
 *
 * 为什么需要：`workspace-write` 放开整个工作区，而 pi 会从 `<cwd>/.pi/` 发现项目级
 * extensions / agents / skills / prompts / themes，并且 **subagent 子会话每次都重新发现**
 * （pi-subagents 为每个子会话另建资源加载器，只传 cwd / agentDir / …，子会话按 agentDir 与项目
 * `.pi/` 重新发现扩展；已核实 `resource-loader.reload()` 会 `clearExtensionCache()`，`/reload`
 * 与 `ctx.reload()` 也会重读扩展代码）。所以沙箱内写 `.pi/agents/x.md` 之后，父会话**下一次
 * subagent 调用**就会以完全权限加载它——不需要 `/reload`、不需要重启。这正是 Claude Code 的
 * protected paths 与 Codex 的「`.git`、`.codex` 在任何可写根下恒只读」所挡的那一类。
 *
 * pi 的项目信任门（`TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`）挡不住这条：它只覆盖 pi 自己的
 * `settings.json`/`extensions`/`skills`/…，且信任判定发生在**加载前**——本项目本来就是已信任的。
 *
 * 目录名用宿主的 `CONFIG_DIR_NAME`（默认 `.pi`，但可被 `pkg.piConfig.configDir` 覆盖），不硬编码。
 *
 * spec: docs/superpowers/specs/2026-10-14-protected-project-config-design.md
 */

/** 受保护根的测试注入点（testing.md「参数注入」）；生产不传。 */
export interface ProtectedHooks {
	/** 缺省 node:fs existsSync。 */
	exists?: (path: string) => boolean;
	/** 缺省宿主的 CONFIG_DIR_NAME；注入以便测试目录名可覆盖的情形。 */
	configDirName?: string;
}

/**
 * 工作区内所有受保护（恒只读）的根。当前只有一个：pi 的项目配置目录。
 *
 * 返回的是**路径**，与存在性无关——围栏侧对不存在的路径同样要拒（否则「从零创建 `.pi/`」
 * 这条最主要的攻击形状就漏了）。runner 侧的存在性门控见 `carveOutRoots`。
 */
export function protectedRoots(workspaceRoot: string, hooks: ProtectedHooks = {}): string[] {
	const name = hooks.configDirName ?? CONFIG_DIR_NAME;
	// 宿主把 configDirName 配成空串/带分隔符的值时不构造出畸形根：那种配置下不保护，
	// 而不是保护到 `/` 或工作区自身（后者会把整个工作区变成只读）。
	if (name.length === 0 || name.includes("/") || name.includes("\\")) return [];
	return [join(workspaceRoot, name)];
}

/**
 * `/permission` 状态行用的「受限 shell 侧覆盖情况」短语。
 *
 * 围栏侧（write/edit）是无条件覆盖的，所以这里只描述 shell 侧——那才是各后端能力不一致、
 * 用户最容易误判的地方（看到“protected”就以为 bash 也挡住了）。不说清等于骗人。
 *
 * @param runnerKind - 选中的后端；null = runner 不参与执行（danger-full-access / unavailable）。
 * @param customRunner - 配了自定义 runnerCommand（声明为 bwrap 兼容，按 bwrap 口径）。
 */
export function shellProtectionNote(
	runnerKind: string | null,
	customRunner: boolean,
	workspaceRoot: string,
	hooks: ProtectedHooks = {},
): string {
	if (customRunner || runnerKind === "bwrap") {
		return carveOutRoots(workspaceRoot, hooks).length > 0
			? "confined shell: protected (read-only bind)"
			: `confined shell: NOT protected yet — ${join(workspaceRoot, hooks.configDirName ?? CONFIG_DIR_NAME)} does not exist, and bwrap cannot ro-bind a missing path (bash could still create it)`;
	}
	if (runnerKind === "seatbelt") {
		// seatbelt 的 deny 对不存在的路径同样有效，所以 macOS 上没有「不存在就不挡」的缺口。
		return "confined shell: protected (seatbelt deny)";
	}
	if (runnerKind === "landlock") {
		return "confined shell: NOT protected — landlock rules are a union and cannot express deny-within-allow (install bwrap to close this)";
	}
	if (runnerKind === "windows-acl") {
		return "confined shell: NOT protected — the windows-acl runner does not implement a carve-out yet";
	}
	return "confined shell: not applicable (no runner in play)";
}

/**
 * runner 侧真正能挖洞的根：**只有已存在的**受保护根（bwrap 口径；seatbelt 不需门控，见
 * `shellProtectionNote` 与 confine 的 `protectedRootsFor`）。
 *
 * 存在性门控是承重的：
 * - bwrap 的 `--ro-bind <src> <src>` 对不存在的 src **硬失败**（实测 `bwrap: Can't find source path …`），
 *   那会被 `classifyRunnerFailure` 归为 SANDBOX_UNAVAILABLE——整条命令跑不起来，而不是被拒；
 * - 用一个「别处的空只读目录」当源 ro-bind 到 `<ws>/.pi` 上确实能挡住（实测沙箱内 mkdir/写入都是
 *   `Read-only file system`），但 bwrap 会**在宿主上真创建** `<ws>/.pi` 空目录，且源目录必须放在
 *   沙箱写不到的地方（`/tmp` 是可写的，放那里等于自废：受限进程能写源目录，内容会透过 bind 出现在
 *   `<ws>/.pi`）。两条都指向同一个结论：不存在就不挖洞，换取零宿主副作用。
 *
 * 因此 `.pi` 不存在时的残余缺口是：**bash 可以从零创建 `.pi/`**（write/edit 仍被围栏拦住，全平台）。
 * seatbelt 无此缺口（它的 deny 对不存在的路径同样有效）。缺口写进 README 与 spec §「已知取舍」。
 */
export function carveOutRoots(workspaceRoot: string, hooks: ProtectedHooks = {}): string[] {
	const exists = hooks.exists ?? existsSync;
	return protectedRoots(workspaceRoot, hooks).filter((root) => exists(root));
}
