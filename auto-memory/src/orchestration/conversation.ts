import type { ExtractMessage } from "./ports.js";

/**
 * 对话渲染：把中立的 `ExtractMessage` 序列压成 extract prompt 里的那一段文本，
 * 并在超出预算时做「首尾优先、中段裁减」。
 *
 * 与 `prompts.ts` 分开是为了不打环：prompt 文本依赖渲染结果，而 `runExtract` 依赖 prompt 文本。
 */

export interface ConversationLimits {
	maxToolResultChars: number;
	maxAssistantChars: number;
	maxContextTokens: number;
}

/** 单条文本的尾部截断。user 消息**不**走这里：优先保留全部 user 消息。 */
function clip(text: string, max: number): string {
	if (max <= 0 || text.length <= max) return text;
	return `${text.slice(0, max)}\n[truncated: ${text.length - max} chars omitted]`;
}

/** 中段裁减的标记行本体（与字符串回退共用，保证两种路径逐字相同）。 */
const middleMarkerLabel = (omitted: number): string => `[truncated: ${omitted} chars omitted from the middle]`;

/**
 * 总预算超限时的**中段**裁减：首尾优先保留。
 * 开头是用户的原始诉求、结尾是最终的结论与纠正，中段大多是可以牺牲的工具输出。
 */
const middleMarker = (omitted: number): string => `\n${middleMarkerLabel(omitted)}\n`;

/**
 * 删掉 `needle` 的**最后一次**出现（连带它后面紧跟的一个 `\n`）；不存在就原样返回。
 *
 * **兜底路径（理论不可达）**：`clipMiddle` 的主路径按 `assemble` 给出的插入位置删除块级
 * 标记；只有位置信息缺失或该位置上不是标记时才回退到这里做字符串搜索。回退也只删最后一次
 * 出现：块级标记总在靠后的位置，而正文里可能有同一串。
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
 * 输出里，于是输出出现两个标记、N 与保留下来的首尾全部错位。
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
 * 结构化渲染整轮对话，每条消息一行：
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
	// 插进去的那一个标记，不能去字符串里搜（正文里可能有一份逐字相同的仿冒串）。
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
		// N 含被丢块的换行（标记行的格式是逐字约定，别改）。
		omitted += dropped.block.length + 1;
		if (firstDropped === -1) firstDropped = dropped.index;
		({ text, markerAt } = assemble());
	}
	return text;
}
