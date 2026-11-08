import type { MemoryAction } from "../tool/actions.js";

/**
 * 适配层要实现的两个端口。
 *
 * 只有两个，因为注入的**机制**与**通知**本来就留在适配层：core 的编排只返回数据
 * （选中的文件名、dream 的摘要文本、`{ skipped, result }`），由适配层决定怎么呈现。
 */

/**
 * 跑一轮受限工具的 headless 会话，返回 assistant 文本。
 *
 * `null` = 本轮**未执行**（宿主拒绝、超时、或适配层判定不该跑）。调用方必须能区分
 * 「跑了但没写出东西」与「根本没跑」：`runExtract` 靠它决定要不要报 `{ skipped: true }`。
 */
export interface HeadlessRunRequest {
	/** prompt 全文，由 core 的 `orchestration/prompts.ts` 生成。 */
	task: string;
	/** 子会话 cwd；dream / extract / 侧查询一律传 memoryDir。 */
	cwd: string;
	/**
	 * 宿主自己的模型标识。core **不解释、不校验**：pi 的模型 id 要经 `ModelRegistry` 解析，
	 * 别的宿主是 `provider` + `model` 两段。可解析性由适配层在启动时校验。
	 */
	model: string;
	/** 宿主的思考/推理档位（pi 的 `ThinkLevel`、别家的 reasoning effort）。core 原样透传。 */
	effort?: string;
	maxTurns?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	/**
	 * 子会话可用的 builtin 工具。
	 * - `"none"`：零工具（侧查询就是这样，零工具是意图本身）；
	 * - `"file-io"`：读写类工具。
	 *
	 * 适配层必须注意宿主的白名单语义：pi 的 `tools: []` 是**白名单**，会连 customTools 一起
	 * 滤掉，所以「关 builtin、只留 memory 工具」只能用 `noTools: "builtin"` 表达。
	 */
	builtinTools: "none" | "file-io";
	/**
	 * 需要注入子会话的 `memory` 工具；`null` = 不注入。
	 * 适配层据此用 core 的 `createMemoryActionHandler` + 自己的 schema/渲染包出真实工具对象。
	 */
	memoryTool: {
		actions: readonly MemoryAction[];
		skipLogicalLock?: boolean;
		skipSnapshot?: boolean;
		onWrite?: (info: { action: MemoryAction; name?: string }) => void;
	} | null;
	/** 宿主自己的会话持久化开关，core 原样透传。 */
	sessionPersistence?: { enabled: boolean; sessionDir?: string };
}

export interface HeadlessAgentPort {
	run(req: HeadlessRunRequest): Promise<string | null>;
}

/**
 * 渲染进 extract prompt 的一条消息。
 *
 * 中立的对话形状：只保留角色、tool_call 的名称与参数摘要、tool_result 的成功/失败标记。
 * 「只把首尾两条消息压成字符串」会让中间的纠正、工具调用与工具结果全部丢失，那是提取失真的根因。
 */
export interface ExtractMessage {
	role: "user" | "assistant" | "toolResult";
	text?: string;
	toolCalls?: Array<{ name: string; args: string }>;
	/** 产生该结果的工具名。保留供诊断（适配层的通知会用到），渲染时不出现。 */
	toolName?: string;
	isError?: boolean;
}

/** 宿主的会话历史：既供 `search scope=sessions`，也供 extract 的对话渲染。 */
export interface HostTranscriptPort {
	/** 搜历史会话，返回已格式化好的文本（宿主决定格式与截断）。 */
	searchSessions(
		cwd: string,
		query: string,
		cfg: { maxSessions: number; maxMatches: number },
	): Promise<string>;
	/**
	 * 把宿主的原始消息序列转成中立的 `ExtractMessage`。
	 * 形状不认识的消息按「尽量保留文本」处理；**未知 role 绝不当作 user**（user 文本不截断，
	 * 且 prompt 会把它当规则/纠正）。
	 */
	toExtractMessages(raw: unknown[]): ExtractMessage[];
}

/** 两个端口的集合。core 的编排函数一律显式收它，不从模块级单例里取。 */
export interface OrchestrationPorts {
	headless: HeadlessAgentPort;
	transcript?: HostTranscriptPort;
}
