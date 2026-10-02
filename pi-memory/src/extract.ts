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

/** 中段裁减的标记行本体（与字符串回退共用，保证两种路径逐字相同）。 */
const middleMarkerLabel = (omitted: number): string => `[truncated: ${omitted} chars omitted from the middle]`;

/**
 * 总预算超限时的**中段**裁减：首尾优先保留（spec §11.2）。
 * 开头是用户的原始诉求、结尾是最终的结论与纠正，中段大多是可以牺牲的工具输出。
 */
const middleMarker = (omitted: number): string => `\n${middleMarkerLabel(omitted)}\n`;

/**
 * 删掉 `needle` 的**最后一次**出现（连带它后面紧跟的一个 `\n`）；不存在就原样返回。
 *
 * **兜底路径（理论不可达）**：`clipMiddle` 的主路径按 `assemble` 给出的插入位置删除块级
 * 标记；只有位置信息缺失或该位置上不是标记时才回退到这里做字符串搜索。回退也只删最后一次
 * 出现（Plan C 终审 #9）：块级标记总在靠后的位置，而正文里可能有同一串。
 */
function removeLastOccurrence(text: string, needle: string): string {
	const at = text.lastIndexOf(needle);
	if (at === -1) return text;
	const trailingNewline = text[at + needle.length] === "\n" ? 1 : 0;
	return `${text.slice(0, at)}${text.slice(at + needle.length + trailingNewline)}`;
}

/**
 * 字符串级的中段裁减：只剩 user 块仍超预算时的回退。
 *
 * `alreadyOmitted` 是块级裁减已经丢掉的字符数，它并入标记里的 N，并且**不再插入第二个标记**
 * —— 输出里 `[truncated: …]` 恒为一个。这一不变量现在真的成立：`markerAt` 是 `assemble`
 * 拼接时算出的标记插入位置，`clipMiddle` 按它删掉**我们自己插进去的那一个**标记，而不是去
 * 字符串里搜。user 正文里完全可能有一份与标记逐字相同的仿冒串（模型/用户抄了我们的截断
 * 标记），它可能落在真标记之前、也可能之后，任何字符串搜索都可能删错那一份、把真标记留在
 * 输出里，于是输出出现两个标记、N 与保留下来的首尾全部错位（Plan C 终审 #9 / Plan D R-D9）。
 * 旧实现直接对「已含块级标记的文本」再裁一次，还额外把旧标记自身的长度算成「省略的正文」。
 */
function clipMiddle(text: string, maxChars: number, alreadyOmitted = 0, markerAt = -1): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	// 块级标记自己占的字符既不是被省略的正文，也不该在输出里出现第二次。
	// 它可能是独立一行（后面跟着 `\n`），也可能被 `assemble` 追加在末尾（后面没有 `\n`）。
	const label = alreadyOmitted > 0 ? middleMarkerLabel(alreadyOmitted) : "";
	// 主路径：按 `assemble` 给出的位置删除；只有位置缺失或那一段不是标记时才落回字符串搜索。
	let body = text;
	if (label !== "") {
		body =
			markerAt >= 0 && text.startsWith(label, markerAt)
				? text.slice(0, markerAt) +
					text.slice(markerAt + label.length + (text[markerAt + label.length] === "\n" ? 1 : 0))
				: removeLastOccurrence(text, label);
	}
	// 给标记文本预留位置（按一个六位数省略量估算），避免「裁减之后反而更长」。
	const budget = Math.max(0, maxChars - middleMarker(999999).length);
	const head = Math.min(Math.ceil(budget / 2), body.length);
	const tail = Math.min(budget - head, Math.max(0, body.length - head));
	const omitted = alreadyOmitted + (body.length - head - tail);
	return `${body.slice(0, head)}${middleMarker(omitted)}${body.slice(body.length - tail)}`;
}

/** 从字符串或内容块数组里抠出文本。`joiner`/`images` 供 custom 消息（空格连接、不要图片占位）使用。 */
function textOf(content: unknown, opts: { joiner?: string; images?: boolean } = {}): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const joiner = opts.joiner ?? "\n";
	const keepImages = opts.images ?? true;
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const part = block as Record<string, unknown>;
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (keepImages && part.type === "image") parts.push("[image]");
	}
	return parts.join(joiner);
}

/** 未知 role 的兜底：按常见字段顺序尽力取文本（`content` → `output` → `text` → `summary`）。 */
function bestEffortText(m: Record<string, unknown>): string {
	for (const field of [m.content, m.output, m.text, m.summary]) {
		const text = textOf(field);
		if (text) return text;
	}
	return "";
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
 * 把 pi 的消息序列（`AgentMessage` 联合类型）转成渲染用的结构。
 *
 * 除了 user / assistant / toolResult，还要认领 pi 的机器消息：
 * - `bashExecution` → `toolResult`（`!!` 前缀即 `excludeFromContext` 的则整条跳过），
 *   这样 `command`/`exitCode` 不再丢失，且自动受 `maxToolResultChars` 与 `[error] ` 前缀约束；
 * - `branchSummary` / `compactionSummary` → `assistant`（带标签），受 `maxAssistantChars` 约束；
 * - `custom` → `assistant`；唯一例外是 `customType === "memory-auto-surfacing"`（pi-memory
 *   自己注入的 `<relevant_memories>`）—— 把记忆正文当 assistant 文本再喂给 extract 等于让
 *   extract 从自己的记忆里反复提取，因此整条跳过。
 *
 * 未知 role **绝不**当作 user（user 文本不截断，且 prompt 会把它当规则/纠正）：按 assistant
 * 尽力保留文本（`content` → `output` → `text` → `summary`），抠不出来才跳过。
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
		if (role === "bashExecution") {
			// `!!` 前缀（excludeFromContext）明确不进 LLM 上下文，extract 也不该看到。
			if (m.excludeFromContext === true) continue;
			const command = typeof m.command === "string" ? m.command : "";
			const output = typeof m.output === "string" ? m.output : "";
			const exitCode = typeof m.exitCode === "number" ? m.exitCode : undefined;
			out.push({
				role: "toolResult",
				toolName: "bash",
				text: `$ ${command}\n${output}`,
				isError: exitCode !== undefined && exitCode !== 0,
			});
			continue;
		}
		if (role === "branchSummary" || role === "compactionSummary") {
			const summary = typeof m.summary === "string" ? m.summary : "";
			if (!summary) continue;
			const label = role === "branchSummary" ? "[branch summary]" : "[compaction summary]";
			out.push({ role: "assistant", text: `${label} ${summary}` });
			continue;
		}
		if (role === "custom") {
			// pi-memory 自己注入的 <relevant_memories> 是「记忆正文的渲染」，不是本轮对话内容。
			// 其他 customType（插件通知等）保持渲染为 assistant。
			if (m.customType === "memory-auto-surfacing") continue;
			const text = textOf(m.content, { joiner: " ", images: false });
			if (text) out.push({ role: "assistant", text });
			continue;
		}

		const text = bestEffortText(m);
		if (text) out.push({ role: "assistant", text });
	}
	return out;
}

/** 单条消息的渲染块（块之间以 `\n` 连接，块内不含分隔换行）。 */
function renderBlock(m: ExtractMessage, index: number, limits: ConversationLimits): string {
	const n = index + 1;
	if (m.role === "user") return `[${n}] user: ${m.text ?? ""}`;
	if (m.role === "assistant") {
		const parts: string[] = [];
		if (m.text) parts.push(clip(m.text, limits.maxAssistantChars));
		for (const call of m.toolCalls ?? []) parts.push(`tool_call: ${call.name}(${clip(call.args, 120)})`);
		return `[${n}] assistant: ${parts.join(" | ")}`;
	}
	const body = m.isError ? `[error] ${m.text ?? ""}` : (m.text ?? "");
	return `[${n}] tool_result: ${clip(body, limits.maxToolResultChars)}`;
}

/**
 * 结构化渲染整轮对话（spec §11.2），每条消息一行：
 *
 *     [1] user: <全文>
 *     [2] assistant: <文本> | tool_call: memory({"action":"list"})
 *     [3] tool_result: <摘要>            // isError 时以 [error] 开头
 *
 * user 文本不截断；assistant 文本按 `maxAssistantChars`；tool_result 按 `maxToolResultChars`。
 * 总长超过 `maxContextTokens * 4` 字符时做**块级中段裁减**：先按单条上限把每条消息渲染成块，
 * 再从中段向外逐块丢弃**非 user** 块（每次丢离中心最近的那块，tie 取靠后的），直到回到预算内，
 * 或只剩 user 块（此时回退到字符串中段裁减）。user 块绝不因丢非 user 块而消失。
 */
export function renderConversation(messages: ExtractMessage[], limits: ConversationLimits): string {
	const blocks = messages.map((m, i) => renderBlock(m, i, limits));
	const maxChars = limits.maxContextTokens * 4;
	if (maxChars <= 0) return blocks.join("\n");

	const remaining = blocks.map((block, index) => ({ block, index, user: messages[index].role === "user" }));
	let omitted = 0;
	let firstDropped = -1;

	// 标记插在首个被丢块的位置（块之间仍以 `\n` 连接，序号沿用原始下标，允许跳号）。
	// 除了文本，还要交出标记在文本里的**插入位置**：`clipMiddle` 只能按这个位置删除自己
	// 插进去的那一个标记，不能去字符串里搜（正文里可能有一份逐字相同的仿冒串，D4/R-D9）。
	const assemble = (): { text: string; markerAt: number } => {
		const lines: string[] = [];
		let markerLine = -1;
		let markerInserted = false;
		for (const entry of remaining) {
			if (!markerInserted && firstDropped >= 0 && entry.index > firstDropped) {
				markerLine = lines.length;
				lines.push(middleMarkerLabel(omitted));
				markerInserted = true;
			}
			lines.push(entry.block);
		}
		if (firstDropped >= 0 && !markerInserted) {
			markerLine = lines.length;
			lines.push(middleMarkerLabel(omitted));
		}
		// `join("\n")` 之后：标记前的每一行各占 `length + 1`（行间分隔符）。
		// 从未丢块时没有标记，`markerAt = -1`。
		let markerAt = -1;
		if (markerLine >= 0) {
			markerAt = 0;
			for (let i = 0; i < markerLine; i++) markerAt += lines[i].length + 1;
		}
		return { text: lines.join("\n"), markerAt };
	};

	let { text, markerAt } = assemble();
	while (text.length > maxChars) {
		const center = (remaining.length - 1) / 2;
		let target = -1;
		let best = Number.POSITIVE_INFINITY;
		for (let i = 0; i < remaining.length; i++) {
			if (remaining[i].user) continue;
			const distance = Math.abs(i - center);
			// `<=` + 升序扫描：距离相同时取靠后的那一块。
			if (distance <= best) {
				best = distance;
				target = i;
			}
		}
		// 只剩 user 块：回退到字符串中段裁减（首尾各约一半并预留标记长度）。
		// 把块级已经省略的量交下去，输出里只会留一个标记。
		if (target === -1) return clipMiddle(text, maxChars, omitted, markerAt);

		const [dropped] = remaining.splice(target, 1);
		// N 含被丢块的换行（spec §11.2 的逐字格式）。
		omitted += dropped.block.length + 1;
		if (firstDropped === -1) firstDropped = dropped.index;
		({ text, markerAt } = assemble());
	}
	return text;
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
			// 没有文件工具：extract 只能通过 memory 原语写（spec §11.2）。
			// 必须用 noTools 而不是 tools: [] —— 后者是白名单，会把 customTools（memory 工具）一起滤掉。
			noTools: "builtin",
			customTools: opts.customTools,
			sessionPersistence: opts.sessionPersistence,
		}),
	);

	if (result === null) return { skipped: true };
	return { skipped: false, result };
}
