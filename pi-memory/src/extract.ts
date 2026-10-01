import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runHeadlessAgent } from "./agent-runner";
import type { SessionPersistenceConfig, ThinkLevel } from "./config";
import type { MemoryStore } from "./memory-store";

/**
 * 渲染进 extract prompt 的一条消息。
 *
 * v1 只把「本轮第一条 user 消息 + 最后一条 assistant 消息」压成 `{role, content}` 字符串交给
 * extract，中间的纠正、工具调用与工具结果全部丢失（spec §11.1）—— 这是提取失真的根因。
 * v2 保留角色、tool_call 的名称与参数摘要、tool_result 的成功/失败标记。
 */
export interface ExtractMessage {
	role: "user" | "assistant" | "toolResult";
	text?: string;
	toolCalls?: Array<{ name: string; args: string }>;
	/** 产生该结果的工具名。保留供诊断（Plan C 的通知会用到），渲染时不出现。 */
	toolName?: string;
	isError?: boolean;
}

export interface ConversationLimits {
	maxToolResultChars: number;
	maxAssistantChars: number;
	maxContextTokens: number;
}

export interface RunExtractOpts {
	model?: string;
	thinkLevel: ThinkLevel;
	memoryDir: string;
	/** 唯一写入通道：extract 的整轮互斥挂在它的 `tryWithLogicalLock` 上。 */
	store: MemoryStore;
	/** pi 的 `agent_end` 消息原样传入（`AgentMessage[]`）。形状不认识的消息按「尽量保留文本」处理。 */
	messages: unknown[];
	maxContextTokens: number;
	maxToolResultChars: number;
	maxAssistantChars: number;
	modelRegistry: ModelRegistry;
	parentModel?: Model<any>;
	sessionPersistence?: SessionPersistenceConfig;
	/** extract 子会话专属的工具集（5 个 action，D12）。 */
	customTools: ToolDefinition[];
	agentsMdBlocks?: string[];
}

/** 单条文本的尾部截断。user 消息**不**走这里（spec §11.2：优先保留全部 user 消息）。 */
function clip(text: string, max: number): string {
	if (max <= 0 || text.length <= max) return text;
	return `${text.slice(0, max)}\n[truncated: ${text.length - max} chars omitted]`;
}

/**
 * 总预算超限时的**中段**裁减：首尾优先保留（spec §11.2）。
 * 开头是用户的原始诉求、结尾是最终的结论与纠正，中段大多是可以牺牲的工具输出。
 */
const middleMarker = (omitted: number): string => `\n[truncated: ${omitted} chars omitted from the middle]\n`;

function clipMiddle(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	// 给标记文本预留位置（按一个六位数省略量估算），避免「裁减之后反而更长」。
	const budget = Math.max(0, maxChars - middleMarker(999999).length);
	const head = Math.ceil(budget / 2);
	const tail = budget - head;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}${middleMarker(omitted)}${text.slice(text.length - tail)}`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const part = block as Record<string, unknown>;
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (part.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

function toolCallsOf(content: unknown): Array<{ name: string; args: string }> {
	if (!Array.isArray(content)) return [];
	const out: Array<{ name: string; args: string }> = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const part = block as Record<string, unknown>;
		if (part.type !== "toolCall" || typeof part.name !== "string") continue;
		let args = "";
		try {
			args = JSON.stringify(part.arguments ?? {});
		} catch {
			args = "";
		}
		out.push({ name: part.name, args });
	}
	return out;
}

/**
 * 把 pi 的消息序列（`UserMessage` / `AssistantMessage` / `ToolResultMessage`）转成渲染用的结构。
 *
 * 未知形状**不静默丢弃**：能抠出文本就按 user 文本保留（宁可多给一点上下文，也不要让整轮对话
 * 因为 pi 的消息类型演进而消失）；抠不出文本（null / 数字 / 空对象）才跳过。
 */
export function toExtractMessages(messages: unknown[]): ExtractMessage[] {
	const out: ExtractMessage[] = [];
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const m = raw as Record<string, unknown>;
		const role = typeof m.role === "string" ? m.role : "";

		if (role === "user") {
			const text = textOf(m.content);
			if (text) out.push({ role: "user", text });
			continue;
		}
		if (role === "assistant") {
			const text = textOf(m.content);
			const toolCalls = toolCallsOf(m.content);
			if (!text && toolCalls.length === 0) continue;
			out.push({
				role: "assistant",
				...(text ? { text } : {}),
				...(toolCalls.length > 0 ? { toolCalls } : {}),
			});
			continue;
		}
		if (role === "toolResult") {
			out.push({
				role: "toolResult",
				text: textOf(m.content),
				toolName: typeof m.toolName === "string" ? m.toolName : undefined,
				isError: m.isError === true,
			});
			continue;
		}

		const text = textOf(m.content) || (typeof m.output === "string" ? m.output : "");
		if (text) out.push({ role: "user", text });
	}
	return out;
}

/**
 * 结构化渲染整轮对话（spec §11.2），每条消息一行：
 *
 *     [1] user: <全文>
 *     [2] assistant: <文本> | tool_call: memory({"action":"list"})
 *     [3] tool_result: <摘要>            // isError 时以 [error] 开头
 *
 * user 文本不截断；assistant 文本按 `maxAssistantChars`；tool_result 按 `maxToolResultChars`；
 * 总长超过 `maxContextTokens * 4` 字符时从中段裁减。
 */
export function renderConversation(messages: ExtractMessage[], limits: ConversationLimits): string {
	const lines: string[] = [];
	messages.forEach((m, i) => {
		const n = i + 1;
		if (m.role === "user") {
			lines.push(`[${n}] user: ${m.text ?? ""}`);
			return;
		}
		if (m.role === "assistant") {
			const parts: string[] = [];
			if (m.text) parts.push(clip(m.text, limits.maxAssistantChars));
			for (const call of m.toolCalls ?? []) parts.push(`tool_call: ${call.name}(${clip(call.args, 120)})`);
			lines.push(`[${n}] assistant: ${parts.join(" | ")}`);
			return;
		}
		const body = m.isError ? `[error] ${m.text ?? ""}` : (m.text ?? "");
		lines.push(`[${n}] tool_result: ${clip(body, limits.maxToolResultChars)}`);
	});
	return clipMiddle(lines.join("\n"), limits.maxContextTokens * 4);
}

/** Build the extraction task prompt. */
export function buildExtractTask(
	messages: ExtractMessage[],
	maxTokens: number,
	agentsMdBlocks: string[],
	opts: { maxToolResultChars: number; maxAssistantChars: number },
): string {
	const conversation = renderConversation(messages, {
		maxToolResultChars: opts.maxToolResultChars,
		maxAssistantChars: opts.maxAssistantChars,
		maxContextTokens: maxTokens,
	});

	return [
		"You are a memory extraction agent. Below is one full turn of a coding session: every user message, every assistant reply, every tool call and every tool result. Decide what is worth remembering for FUTURE sessions and persist it.",
		"",
		"## Tools",
		"Your ONLY tool is `memory`. You have no read, write, edit, ls or bash access.",
		'memory(action="list") — every stored memory: name, type, modified, description, file.',
		'memory(action="search", query="…") — full-text search; returns the whole body of each match.',
		'memory(action="add", name, description, type, content) — create a memory, or overwrite the one whose name matches exactly.',
		'memory(action="replace", name, description, type, content) — rewrite an existing memory.',
		"",
		"## Storage model",
		"- One memory = one file, and MEMORY.md holds exactly one index line per memory.",
		"- `content` IS the memory: write the fact itself, not a pointer to it.",
		"- `name` must be unique and human-readable. Adding a name that already exists overwrites that memory instead of duplicating it.",
		'- `description` is required in practice: it is the only text a future session sees when deciding relevance, so it must be self-contained (what, where, which value). Bad: "Debugging tips". Good: "staging SSH listens on 2222, not 22".',
		"- `type` is one of user / feedback / project / reference (default feedback).",
		"",
		"## Workflow",
		"1. Read the conversation below. Note the corrections the user made, the rules they stated, and the facts that were hard to discover.",
		'2. Call memory(action="list") or memory(action="search") to check whether the fact is already stored.',
		"3. Already stored but wrong or incomplete → replace that exact name. New → add. Already stored correctly → do nothing.",
		"4. Persist at most a handful of memories per turn. When in doubt, skip it.",
		"",
		"## What to Remember",
		'- Process rules: "Always do X" / "Never do Y" directives, workflow discipline, reporting standards, self-check habits — treat these as seriously as technical facts',
		"- User preferences: coding style, tool choices, naming conventions, workflow habits",
		"- Project conventions: architecture decisions, file organization, tech stack choices",
		"- Discoveries: debugging workarounds, gotchas, configuration quirks, undocumented behavior",
		"- References: external docs, APIs, or systems the user treats as important",
		"- AGENTS.md rules that were violated in this conversation — extract for memory-level reinforcement (refer to the AGENTS.md content below)",
		"",
		"## What to Skip",
		"- One-time task instructions or ephemeral details",
		"- Code snippets or file paths derivable from the project",
		"- AGENTS.md rules that were followed without issue (refer to the AGENTS.md content below)",
		"- Git history or recent changes",
		"- Obvious or trivial observations",
		"",
		"## Output",
		'Persist the memories with the `memory` tool, then reply with one short line saying how many you added or replaced (or "nothing worth saving").',
		"",
		...(agentsMdBlocks.length > 0 ? ["## AGENTS.md Rules", ...agentsMdBlocks, ""] : []),
		"=== Conversation ===",
		conversation,
	].join("\n");
}

/**
 * 跑一轮 extract（spec §5.2 / §11）。
 *
 * **不等待逻辑锁**：拿不到就跳过本轮并返回 `{ skipped: true }`。extract 在每次 `agent_end` 都触发，
 * 让它排队等 dream（分钟级）只会把一批批早已过时的对话堆在队列里，等 dream 结束后依次重放。
 *
 * 错误**不吞**：v1 内部的 `.catch(() => {})` 让 extract 的失败对用户完全不可见（spec §14）。
 * 由调用方决定如何呈现（Plan C 会换成限流通知）。
 */
export async function runExtract(opts: RunExtractOpts): Promise<{ skipped: boolean; result?: string }> {
	const messages = toExtractMessages(opts.messages);
	if (messages.length === 0) return { skipped: true };

	const task = buildExtractTask(messages, opts.maxContextTokens, opts.agentsMdBlocks ?? [], {
		maxToolResultChars: opts.maxToolResultChars,
		maxAssistantChars: opts.maxAssistantChars,
	});

	const result = await opts.store.tryWithLogicalLock(() =>
		runHeadlessAgent({
			task,
			cwd: opts.memoryDir,
			modelRegistry: opts.modelRegistry,
			model: opts.model,
			parentModel: opts.parentModel,
			thinkLevel: opts.thinkLevel,
			maxTurns: 5,
			timeoutMs: 120_000,
			// 没有文件工具：extract 只能通过 memory 原语写（spec §11.2）
			tools: [],
			customTools: opts.customTools,
			sessionPersistence: opts.sessionPersistence,
		}),
	);

	if (result === null) return { skipped: true };
	return { skipped: false, result };
}
