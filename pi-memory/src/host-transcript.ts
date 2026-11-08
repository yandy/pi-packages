import type { ExtractMessage, HostTranscriptPort } from "@yandy0725/auto-memory";
import { searchSessions } from "./session-search";

/**
 * pi 的 `HostTranscriptPort` 实现：把 pi 的消息形状翻成 core 的中立 `ExtractMessage`，
 * 并把「搜历史会话」接到 pi 的 `SessionManager` 上。
 *
 * 这一整个文件都是宿主知识 —— core 只认 `ExtractMessage`，对 pi 的 `AgentMessage`、
 * bash 执行记录、branch/compaction 摘要一无所知。
 */

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
/** 组装 pi 的两个宿主能力，交给 core 的 `runExtract` 与 `memory` 工具。 */
export function createPiTranscript(): HostTranscriptPort {
	return { searchSessions, toExtractMessages };
}
