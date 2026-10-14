import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	grantArgs,
	LAUNCHER_BIN,
	LAUNCHER_FAILURE_EXIT,
	launcherPath,
	probe as probeLandlockLauncher,
} from "@deepseek-ai/node-addon-system/landlock-run";
import { canonicalPath, defaultTmpRoots, writableRoots, type ConfinedSandboxMode } from "./policy";

export { LAUNCHER_BIN, LAUNCHER_FAILURE_EXIT };

export type SandboxEnforcement = "full" | "partial";
export type RunnerKind = "bwrap" | "landlock" | "seatbelt" | "windows-acl";
export type SelectedRunner = { runner: RunnerKind; enforcement: SandboxEnforcement } | { runner: "unavailable" };

export interface RunnerPolicy {
	mode: ConfinedSandboxMode;
	workspaceRoot: string;
	/**
	 * sandbox.json 的 `writableRoots` 经 config.resolveConfiguredRoots 解析后的额外可写根
	 * （已展开/已拒危险根/已按存在性过滤/已 canonical）。
	 * bwrap / landlock / seatbelt 三者都消费它；**windows-acl 忽略**（Ruling 5：runner 是写死的
	 * --workspace/--temp 两根 argv 契约，N 根需要新的 SID 域分隔与默认 DACL 语义，本期不做）。
	 */
	extraRoots?: readonly string[];
	/**
	 * 可写根**内部**的只读挖洞（deny-within-allow，spec 2026-10-14-protected-project-config）。
	 * 缺省由 confine 自动探测（`carveOutRoots`：**仅已存在的**受保护根）；显式传 `[]` 可关闭。
	 * bwrap / seatbelt 能表达挖洞；**landlock 不能**（规则是并集，无 deny），**windows-acl 本期不能**
	 * （需 deny ACE / 断继承，是 argv 契约改动）——两者靠围栏侧兜底，缺口已写进 README。
	 */
	protectedRoots?: readonly string[];
}

/**
 * bwrap / landlock 共用的可写根序列：/tmp → workspace → 额外根，去重。
 * 顺序是刻意保留的：额外根一律**追加在末尾**，`extraRoots` 为空时产出的 argv 与引入它之前
 * 逐字节相同（tests/runners.test.ts 逐字钉住了完整数组）。去重防止用户把 `/tmp` 也写进配置时
 * bwrap 收到重复的 `--bind /tmp /tmp`。
 */
function confinedWriteRoots(policy: RunnerPolicy): string[] {
	return [...new Set(["/tmp", policy.workspaceRoot, ...(policy.extraRoots ?? [])])];
}

/** 测试钩子：注入平台/probe/launcher 路径，单测不依赖真实 bwrap/landlock（deepseek 同款）。 */
export interface RunnerHooks {
	platform?: string;
	probeBwrap?: (timeoutMs: number) => boolean;
	probeLandlock?: (launcher: string, timeoutMs: number) => SandboxEnforcement | "unusable";
	launcherPath?: () => string;
	seatbeltExec?: string;
	/** 覆盖 win32 rung 的前置检查结论（测试注入）；返回 undefined 表示该 rung 不可用。 */
	windowsAclRung?: () => { node: string; runner: string } | undefined;
	/** 注入 win32 的 node 可执行文件；存在即权威（显式 undefined = 模拟探测不到 node），不再跑真实探测。 */
	nodeExecutable?: string;
	/** 覆盖 win32 runner 入口文件路径。 */
	windowsRunnerPath?: string;
	/** 覆盖 koffi 可解析性探测。 */
	koffiResolvable?: () => boolean;
}

/**
 * bwrap mount profile（deepseek profiles.ts 语义，/tmp 一处为 2026-10-01 的有意偏离，见 spec §4）：
 * 宿主 / 全盘 ro-bind（一切可读），workspace-write 追加宿主 /tmp、工作区与配置的额外根的 rw bind——
 * 全部原路径透明：沙箱内的 /tmp 就是宿主 /tmp（跨命令、跨 read/write 工具语义一致）。
 *
 * 额外根已在 config.resolveConfiguredRoots 里按存在性过滤过：`--bind <src> <src>` 对不存在的 src
 * 会硬失败（`bwrap: Can't bind …`），那会被 classifyRunnerFailure 归为 SANDBOX_UNAVAILABLE 而不是拒绝。
 */
export function bwrapProfileArgs(policy: RunnerPolicy): string[] {
	const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent"];
	if (policy.mode === "workspace-write") {
		for (const root of confinedWriteRoots(policy)) args.push("--bind", root, root);
		// 挖洞必须排在所有 rw bind **之后**：bwrap 按序挂载，后来的挂载遮蔽先前的。
		// 真机实测（2026-10-14）：`--bind <ws> <ws> --ro-bind <ws>/.pi <ws>/.pi` 下
		// `touch <ws>/ok` 成功而 `touch <ws>/.pi/x` 报 `Read-only file system`——后者正是
		// DENIAL_SIGNATURES.bwrap 的方言，所以 denial 记账与提权链路零改动即可用。
		for (const root of policy.protectedRoots ?? []) args.push("--ro-bind", root, root);
	}
	return args;
}

/**
 * Landlock 允许清单：readOnly / + readWrite /dev/null（workspace-write 追加 /tmp、工作区与额外根）。
 *
 * **无法表达挖洞**：Landlock 的规则是权限的**并集**，没有 deny，也不能从已授予的父目录里减去
 * 一个子目录（按“逐个列出 `.pi` 的兄弟目录”绕也不行：兄弟集是动态的、新建文件覆盖不到）。
 * 所以 landlock 回退下 `.pi` 的保护只有围栏侧（write/edit）生效，bash 侧不生效——
 * 记在 README 的已知缺口里。bwrap 在链上优先，只有它不可用时才回退到 landlock。
 */
export function landlockProfileArgs(policy: RunnerPolicy): string[] {
	const readWrite = ["/dev/null"];
	if (policy.mode === "workspace-write") {
		readWrite.push(...confinedWriteRoots(policy));
	}
	return grantArgs({ readOnly: ["/"], readWrite });
}

/** 把一个路径引用为 SBPL 字符串字面量（转义 \ 与 "）。 */
function sbplString(path: string): string {
	return `"${path.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

/**
 * Seatbelt SBPL：默认允许、拒绝一切文件写，放行 /dev/null 与 writableRoots
 * （与 fs 围栏共用 policy.writableRoots 推导，防止语义漂移），最后把受保护根挖回只读。
 *
 * deny 追加在**最后**：本 profile 本来就依赖“后者覆盖前者”（`(deny file-write*)` 之后再
 * `(allow file-write* …)`），且 `.pi` 的 subpath 比工作区的更具体，两种常见的 SBPL 求值口径
 *（顺序优先 / 最具体优先）下结果一致。无 macOS 宿主与 CI 可验，已在 spec 里记为待真机确认。
 */
export function seatbeltProfileArgs(policy: RunnerPolicy): string[] {
	const forms = [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write* (literal ${sbplString("/dev/null")}))`,
	];
	const roots = writableRoots(policy.mode, policy.workspaceRoot, defaultTmpRoots(), policy.extraRoots ?? []);
	if (roots.length > 0) {
		forms.push(`(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`);
	}
	for (const root of policy.protectedRoots ?? []) {
		forms.push(`(deny file-write* (subpath ${sbplString(root)}))`);
	}
	return ["-p", forms.join(" ")];
}

const PLATFORM_CHAINS: Record<string, readonly RunnerKind[]> = {
	linux: ["bwrap", "landlock"],
	darwin: ["seatbelt"],
	// win32 唯一候选（spec Ruling 1）：不做功能探测（选型期绝不 spawn），只做可解析性前置检查——
	// runner 文件 / koffi / node 任何缺失都在选型期落到 unavailable，而不是运行期的 spawn ENOENT。
	win32: ["windows-acl"],
};

const STATIC_ENFORCEMENT: Record<RunnerKind, SandboxEnforcement> = {
	bwrap: "full",
	landlock: "full",
	seatbelt: "full",
	// spec Ruling 6：win32 恒为 partial。三处结构性缺口（继承自 dsh，保留文档、无法闭合）：
	// 1. NTFS 硬链接是文件对象别名：工作区内已授权文件的硬链接在工作区外同样可写；
	// 2. 读不受限：WRITE_RESTRICTED 只交叉检查写访问，受限进程能读调用者可读的一切；
	// 3. 被其他 AppContainer 工具以包 SID 打标过的文件对 Low 完整性令牌不可读。
	"windows-acl": "partial",
};

let cachedVerdict: SelectedRunner | undefined;

/** 清探测缓存（测试用；生产进程内探测只做一次）。 */
export function resetRunnerCache(): void {
	cachedVerdict = undefined;
}

/** 默认 runner 入口：包内 src/win32/runner.js（相对本模块，发布后位于 node_modules 内）。 */
function defaultWindowsRunnerPath(): string {
	return fileURLToPath(new URL("./win32/runner.js", import.meta.url));
}

/** win32 的 node 可执行文件：Node 运行时用 execPath；bun 或打包运行时回退 PATH 上的 node.exe。 */
function defaultNodeExecutable(): string | undefined {
	if (process.versions.node !== undefined && process.versions.bun === undefined) return process.execPath;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir.length === 0) continue;
		const candidate = join(dir, "node.exe");
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function defaultKoffiResolvable(): boolean {
	try {
		createRequire(import.meta.url).resolve("koffi");
		return true;
	} catch {
		return false;
	}
}

/**
 * win32 rung 的可用性前置检查（spec Ruling 1）：runner 文件存在、koffi 可解析、有 node 可执行文件，
 * 三项全过才返回 { node, runner }；任何缺失返回 undefined（调用方转 SANDBOX_UNAVAILABLE）。
 * 纯可解析性检查，绝不 spawn 任何进程。
 *
 * 注入即权威：`windowsAclRung` 存在时其返回值即结论（含显式 undefined = 不可用）；
 * `nodeExecutable` 存在时同理不回退真实探测（显式 undefined = 模拟探测不到 node）。
 */
export function windowsAclAvailability(hooks: RunnerHooks = {}): { node: string; runner: string } | undefined {
	if (hooks.windowsAclRung !== undefined) return hooks.windowsAclRung();
	const node = Object.hasOwn(hooks, "nodeExecutable") ? hooks.nodeExecutable : defaultNodeExecutable();
	const runner = hooks.windowsRunnerPath ?? defaultWindowsRunnerPath();
	const koffiOk = (hooks.koffiResolvable ?? defaultKoffiResolvable)();
	if (node === undefined || !existsSync(runner) || !koffiOk) return undefined;
	return { node, runner };
}

export function defaultProbeBwrap(timeoutMs: number): boolean {
	const probe = spawnSync("bwrap", [...bwrapProfileArgs({ mode: "read-only", workspaceRoot: "/" }), "--", "true"], {
		timeout: timeoutMs,
		stdio: "ignore",
	});
	return probe.status === 0;
}

/**
 * 平台链选择（spec §3）：单候选直接选定（seatbelt 执行期拒绝即 fail-closed）；
 * 多候选按序功能探测；全不可用 → unavailable（调用方必须抛错，绝不裸跑）。
 */
export function selectRunner(probeTimeoutMs: number, hooks: RunnerHooks = {}): SelectedRunner {
	cachedVerdict ??= chainVerdict(probeTimeoutMs, hooks);
	return cachedVerdict;
}

function chainVerdict(probeTimeoutMs: number, hooks: RunnerHooks): SelectedRunner {
	const chain = PLATFORM_CHAINS[hooks.platform ?? process.platform] ?? [];
	const [first, ...rest] = chain;
	if (first === undefined) return { runner: "unavailable" };
	if (first === "windows-acl") {
		if (windowsAclAvailability(hooks) === undefined) return { runner: "unavailable" };
		return { runner: "windows-acl", enforcement: STATIC_ENFORCEMENT["windows-acl"] };
	}
	if (rest.length === 0) return { runner: first, enforcement: STATIC_ENFORCEMENT[first] };
	for (const kind of chain) {
		const enforcement = probeRunner(kind, probeTimeoutMs, hooks);
		if (enforcement !== "unusable") return { runner: kind, enforcement };
	}
	return { runner: "unavailable" };
}

function probeRunner(kind: RunnerKind, probeTimeoutMs: number, hooks: RunnerHooks): SandboxEnforcement | "unusable" {
	switch (kind) {
		case "bwrap":
			return (hooks.probeBwrap ?? defaultProbeBwrap)(probeTimeoutMs) ? "full" : "unusable";
		case "landlock": {
			const launcher = (hooks.launcherPath ?? launcherPath)();
			const probe = hooks.probeLandlock ?? ((l: string, t: number) => probeLandlockLauncher(l, { timeoutMs: t }));
			return probe(launcher, probeTimeoutMs);
		}
		case "seatbelt":
			return "full"; // 单候选链不会走到探测；保留分支的完备性
		case "windows-acl":
			return "unusable"; // win32 是唯候选链，chainVerdict 已前置解析可解析性，永不走到探测
	}
}

/** win32 runner 的前缀：node + 包内 runner.js + 授权根/模式；'--' 与命令 argv 由 confine 拼接。
 * `--temp` 用与 fs 围栏同一个根（canonicalPath(tmpdir())，win32 的 defaultTmpRoots）。
 * **Ruling 5：`policy.extraRoots` 在这里被有意忽略**——runner 的 argv 契约是写死的两根
 * （src/win32/cli.js:8-13），推广到 N 根需要新的 SID 域分隔方案、N 根下的默认 DACL 语义
 * 与 assertGrantRootsDisjoint 的推广（spec 2026-10-14 §5.3）。忽略是 fail-closed 方向的：
 * win32 上围栏（write/edit）生效而受限 powershell 不生效，不对称已在 config.resolveConfiguredRoots
 * 里 warn 一次并记在 README。`policy.protectedRoots` 同样被忽略：在已授权根上挖只读洞需要
 * deny ACE 或断继承，也是 argv 契约改动（spec 2026-10-14-protected-project-config）。 */
export function windowsAclRunnerArgv(policy: RunnerPolicy, availability: { node: string; runner: string }): string[] {
	return [
		availability.node,
		availability.runner,
		"--workspace",
		policy.workspaceRoot,
		"--temp",
		canonicalPath(tmpdir()),
		"--mode",
		policy.mode,
	];
}

/**
 * 选中 runner 对一份策略的完整调用前缀（'--' 与命令 argv 由 confine 拼接）。
 * win32 需要前置检查的结论：约定由 confine 解析一次并透传 `availability`（避免重复解析）；
 * 缺省时本函数自行解析（hook 注入优先），解析不到即抛——绝不构造跑不起来的 argv。
 */
export function runnerInvocation(
	selected: SelectedRunner & { runner: RunnerKind },
	policy: RunnerPolicy,
	hooks: RunnerHooks = {},
	availability?: { node: string; runner: string },
): string[] {
	switch (selected.runner) {
		case "bwrap":
			return ["bwrap", ...bwrapProfileArgs(policy)];
		case "landlock":
			return [(hooks.launcherPath ?? launcherPath)(), ...landlockProfileArgs(policy)];
		case "seatbelt":
			return [hooks.seatbeltExec ?? "sandbox-exec", ...seatbeltProfileArgs(policy)];
		case "windows-acl": {
			const resolved = availability ?? windowsAclAvailability(hooks);
			if (resolved === undefined) {
				throw new Error("windows-acl is unavailable: missing runner file, koffi, or a node executable");
			}
			return windowsAclRunnerArgv(policy, resolved);
		}
	}
}
