import type { SessionPersistenceConfig } from "../config.js";
import type { MemoryStore } from "../store/memory-store.js";
import { MAIN_AGENT_ACTIONS, type MemoryAction } from "../tool/actions.js";
import { buildExtractTask } from "./prompts.js";
import type { HeadlessAgentPort, HostTranscriptPort } from "./ports.js";

export interface RunExtractOpts {
	/** 必填：模型来自显式配置（启动校验已保证可解析），没有父模型回退。 */
	model: string;
	/** 宿主的思考/推理档位。core 不解释，原样透传给端口。 */
	effort?: string;
	memoryDir: string;
	/** 唯一写入通道：extract 的整轮互斥挂在它的 `tryWithLogicalLock` 上。 */
	store: MemoryStore;
	/** 宿主的原始消息序列（pi 的 `AgentMessage[]` 等），经 `ports.transcript` 转成中立形状。 */
	messages: unknown[];
	maxContextTokens: number;
	maxToolResultChars: number;
	maxAssistantChars: number;
	sessionPersistence?: SessionPersistenceConfig;
	agentsMdBlocks?: string[];
	/**
	 * 子会话里的 `memory` 工具每成功写入一条就回调一次。
	 *
	 * extract 跑在 headless 子会话里，适配层看不到它写了几条，只能靠这个回调计数（用来决定
	 * 要不要弹「Extracted N memories」）。core 不解释它，只负责透到工具规格里。
	 */
	onWrite?: (info: { action: MemoryAction; name?: string }) => void;
}

export interface ExtractPorts {
	headless: HeadlessAgentPort;
	transcript: HostTranscriptPort;
}

/**
 * 跑一轮 extract。
 *
 * **不等待逻辑锁**：拿不到就跳过本轮并返回 `{ skipped: true }`。extract 在每轮结束都触发，
 * 让它排队等 dream（分钟级）只会把一批批早已过时的对话堆在队列里，等 dream 结束后依次重放。
 *
 * 错误**不吞**：吞掉会让 extract 的失败对用户完全不可见。由调用方决定如何呈现（适配层通常
 * 做限流通知）。
 */
export async function runExtract(
	opts: RunExtractOpts,
	ports: ExtractPorts,
): Promise<{ skipped: boolean; result?: string }> {
	const messages = ports.transcript.toExtractMessages(opts.messages);
	if (messages.length === 0) return { skipped: true };

	const task = buildExtractTask(messages, opts.maxContextTokens, opts.agentsMdBlocks ?? [], {
		maxToolResultChars: opts.maxToolResultChars,
		maxAssistantChars: opts.maxAssistantChars,
	});

	const result = await opts.store.tryWithLogicalLock(() =>
		ports.headless.run({
			task,
			cwd: opts.memoryDir,
			model: opts.model,
			effort: opts.effort,
			maxTurns: 5,
			timeoutMs: 120_000,
			// 没有文件工具：extract 只能通过 memory 原语写。
			builtinTools: "none",
			memoryTool: { actions: MAIN_AGENT_ACTIONS, skipLogicalLock: true, onWrite: opts.onWrite },
			sessionPersistence: opts.sessionPersistence,
		}),
	);

	if (result === null) return { skipped: true };
	return { skipped: false, result };
}

