import {
	DREAM_ACTIONS,
	MAIN_AGENT_ACTIONS,
	MEMORY_TOOL_DESCRIPTION,
	MEMORY_TOOL_GUIDELINES,
	MEMORY_TOOL_LABEL,
	MEMORY_TOOL_NAME,
	MEMORY_TOOL_SNIPPET,
	type MemoryAction,
	type MemoryActionResult,
	type MemoryHandlerDeps,
	createMemoryActionHandler,
	memoryToolSchema,
} from "@yandy0725/auto-memory";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";

/**
 * pi 适配层的 `memory` 工具：把 core 的中立契约（JSON Schema + 文案 + action handler）包成 pi 的
 * `ToolDefinition`。这里只剩三件 pi 专属的事 ——
 *
 * 1. **schema 转换**：core 给纯 JSON Schema，pi 要 typebox 的 `TSchema`。`action` 的枚举必须用
 *    pi-ai 的 `StringEnum` 重建（它带 pi 的枚举渲染语义），其余字段用 `Type.Unsafe` 原样承接。
 *    转换结果与 core 的 JSON 往返后**逐字相等**，由 `tests/memory-tool.test.ts` 钉住 ——
 *    这条不变量保证拆分前后发给模型的线格式没有变化。
 * 2. **渲染**：`renderCall` / `renderResult` 用 pi-tui 的 `Text`，完全不进 LLM。
 * 3. **通知**：`ctx.ui.notify` 是 pi 的通道，core 不认识它。
 */
export { DREAM_ACTIONS, MAIN_AGENT_ACTIONS };
export type { MemoryAction };

/** pi 侧比 core 的 handler 依赖多一个 `getMemoryDir`：`/memory` 命令与诊断输出要用。 */
export interface MemoryToolDeps extends MemoryHandlerDeps {
	/**
	 * 保留给诊断与 `/memory` 的状态输出。工具本身**不直接读目录** ——
	 * `MemoryStore` 是唯一写入通道，也是唯一的读取入口。
	 */
	getMemoryDir: () => string | null;
}

export interface MemoryToolOptions {
	/** 本 session 可见的 action 子集。缺省 = 主 agent 的 5 个。 */
	actions?: readonly MemoryAction[];
	/** 整轮逻辑锁持有者（dream / extract）传 true。 */
	skipLogicalLock?: boolean;
	/** dream 传 true：进入时已对整目录拍过一次快照。 */
	skipSnapshot?: boolean;
	/** 每次成功写 action 之后回调；index.ts 用它给 extract 统计本轮写入条数。 */
	onWrite?: (info: { action: MemoryAction; name?: string }) => void;
}

/** 把 core 的 JSON Schema 转成 pi 的 `TSchema`。 */
function buildParameters(actions: readonly MemoryAction[]): TSchema {
	const json = memoryToolSchema(actions);
	const required = new Set(json.required);
	const props: Record<string, TSchema> = {};
	for (const [key, field] of Object.entries(json.properties)) {
		const { enum: values, ...rest } = field;
		// `StringEnum` 就是 `Type.Unsafe({ type: "string", enum, description })`（pi-ai 的
		// typebox-helpers），单独走它是为了拿到 pi 对枚举参数的渲染与校验语义。
		const schema = values
			? StringEnum(values, { description: rest.description })
			: Type.Unsafe<unknown>({ ...rest });
		props[key] = required.has(key) ? schema : Type.Optional(schema);
	}
	return Type.Object(props);
}

export function createMemoryTool(deps: MemoryToolDeps, options: MemoryToolOptions = {}): ToolDefinition {
	const actions = options.actions ?? MAIN_AGENT_ACTIONS;
	const handler = createMemoryActionHandler(deps, options);

	return {
		name: MEMORY_TOOL_NAME,
		label: MEMORY_TOOL_LABEL,
		description: MEMORY_TOOL_DESCRIPTION,
		promptSnippet: MEMORY_TOOL_SNIPPET,
		promptGuidelines: [...MEMORY_TOOL_GUIDELINES],
		parameters: buildParameters(actions),
		// biome-ignore lint/suspicious/noExplicitAny: renderCall args
		renderCall(args: any, theme: any) {
			let t = theme.fg("toolTitle", theme.bold("memory ")) + theme.fg("muted", String(args.action));
			if (args.name) t += ` ${theme.fg("accent", args.name)}`;
			if (args.new_name) t += ` ${theme.fg("accent", `→ ${args.new_name}`)}`;
			if (args.query) t += ` ${theme.fg("dim", `"${args.query}"`)}`;
			return new Text(t, 0, 0);
		},
		// biome-ignore lint/suspicious/noExplicitAny: renderResult expanded param
		renderResult(result: any, { expanded: _expanded }: any, theme: any) {
			const txt = result.content?.[0];
			const text = txt?.type === "text" ? txt.text : "";
			if (result.details?.error) return new Text(theme.fg("error", `Error: ${result.details.error}`), 0, 0);
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text.split("\n")[0]), 0, 0);
		},
		// biome-ignore lint/suspicious/noExplicitAny: execute params
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
			const result: MemoryActionResult = await handler(params);
			// 通知本身必须包起来：`ctx.ui` 是宿主代理，session dispose 之后 notify 会抛 ——
			// 一次**已经落盘**的写入不能因此变成工具错误，否则模型会以为没存下来而重复写。
			// headless 会话（extract / dream）`hasUI` 为 false，天然不通知；旧调用形状完全不传 ctx。
			if (params?.action === "add" && ctx?.hasUI) {
				try {
					ctx.ui.notify(`Saved: ${String(params.name ?? "").trim()}`, "info");
				} catch {
					/* UI 已失效：宿主不再收这条通知，写入结果不受影响 */
				}
			}
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	};
}
