/**
 * 配置加载告警的出口（2026-11-18 决策）。
 *
 * `sandbox.json` / `sandbox-writable.json` 在扩展 factory 顶部就被读取，那一刻还没有 `ctx`：
 * 直接 `console.warn` 会把文字写到终端上，随后被 TUI 绘制覆盖——用户既看不到告警、界面也被
 * 弄脏（实测：`extraWritableDirs entry is not an existing directory: …` 一闪而过）。
 *
 * 所以告警先入缓冲，由 `index.ts` 在 `session_start` 拿到 `ctx` 后经 `setConfigWarningSink`
 * 安装真正的出口：
 * - 有 UI（`tui` / `rpc`）→ `ctx.ui.notify(message, "warning")`，落在对话区；
 * - 本进程从未出现过 UI（`pi -p` / JSON 模式）→ `console.warn`（stderr），保持可见；
 * - 无 UI 但本进程已有 UI 会话（pi-subagents 子会话，以及子会话 cwd 不同触发的重新 import）
 *   → 不打印：那会覆盖父会话的 TUI。告警留在缓冲里，等下一个有 UI 的会话补发。
 */
export type ConfigWarningSink = (message: string) => void;

const pendingWarnings: string[] = [];
let warningSink: ConfigWarningSink | null = null;

/**
 * 进程级「已经出现过带 UI 的会话」标志，必须挂 globalThis 而不是模块变量：宿主的扩展模块缓存
 * 以 (cwd, generation) 为令牌（见 src/permission.ts 的同款说明），子会话 cwd 与父不同时会重新
 * import 整个扩展，模块级标志会复位成 false——子会话就不能判断"打印会覆盖父会话界面"。
 */
const UI_SEEN_KEY = Symbol.for("@yandy0725/pi-sandbox:ui-seen");

function processFlags(): Record<symbol, unknown> {
	return globalThis as unknown as Record<symbol, unknown>;
}

/** 本进程是否已经出现过带 UI 的会话（跨模块实例共享）。 */
export function processHasUI(): boolean {
	return processFlags()[UI_SEEN_KEY] === true;
}

/** 标记本进程有 UI 会话（由 index.ts 在拿到可用的 ctx.ui 时调用）。 */
export function markProcessHasUI(): void {
	processFlags()[UI_SEEN_KEY] = true;
}

/** 记一条配置告警：有出口就直发，否则入缓冲。出口抛错（陈旧 ctx 等）时放回缓冲，不吞也不炸。 */
export function reportConfigWarning(message: string): void {
	if (warningSink !== null) {
		try {
			warningSink(message);
			return;
		} catch {
			// 落到下面的入缓冲分支：告警不丢，加载路径也不因 UI 异常而失败
		}
	}
	pendingWarnings.push(message);
}

/** 安装告警出口并补发缓冲；传 null 摘除（之后的告警重新入缓冲）。 */
export function setConfigWarningSink(next: ConfigWarningSink | null): void {
	warningSink = next;
	if (next === null) return;
	for (const message of pendingWarnings.splice(0)) reportConfigWarning(message);
}

/** 取走缓冲里的告警（无 UI 的 print/json 出口用；测试也用它断言）。 */
export function takeConfigWarnings(): string[] {
	return pendingWarnings.splice(0);
}

/** 仅供测试复位（生产代码不得调用）：缓冲、出口与进程级 UI 标志全部清空。 */
export function resetConfigWarningStateForTests(): void {
	pendingWarnings.length = 0;
	warningSink = null;
	delete processFlags()[UI_SEEN_KEY];
}
