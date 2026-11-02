#!/usr/bin/env node
/**
 * A/B 实验用的观察扩展（不是 pi-todo 的一部分）。
 *
 * 为什么需要它：提醒是**请求级注入、不落盘**（见 spec §4.2），所以 session jsonl 里
 * 永远找不到 `<todo-reminder>`。只看会话文件无法区分「提醒没触发」和「触发了但没用」，
 * 这正是 2026-10-10 那轮 T3-B 被误判为有效的原因。这里在 provider 请求序列化后数一次，
 * 给出确凿的「本次 run 到底注入了几次」。
 *
 * 用法：pi -ne -e <pi-todo/index.ts> -e scripts/todo-nag-spy.ts ...（环境变量见下）
 *   PI_TODO_SPY_OUT  输出 jsonl 路径（不设则不写）
 *   PI_TODO_SPY_RUN  run 标识，写进每行
 */

import { appendFileSync } from "node:fs";
import type { BeforeProviderRequestEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER = "<todo-reminder>";

/** 单次 run 的计数器：每条 provider 请求一行。 */
interface SpyRecord {
	run: string;
	request: number;
	/** 本次请求里 <todo-reminder> 出现的次数（同一请求重复出现说明注入逻辑有 bug）。 */
	count: number;
	/** 消息条数，用于确认注入确实加了一条。 */
	messages: number;
	ts: string;
}

export default function (pi: ExtensionAPI) {
	let request = 0;

	pi.on("before_provider_request", async (event: BeforeProviderRequestEvent) => {
		request += 1;
		// payload 的结构按 provider 不同（有的把 system 放 messages[0]），所以直接整体序列化，
		// 只数字面量出现次数 —— 提醒的标记文本不会出现在工具描述/guidelines 里，计数是干净的。
		const serialized = JSON.stringify(event.payload ?? {});
		const count = serialized.split(MARKER).length - 1;
		const payload = event.payload as { messages?: unknown[] } | undefined;
		const messages = Array.isArray(payload?.messages) ? payload.messages.length : 0;

		const out = process.env.PI_TODO_SPY_OUT;
		if (out) {
			const record: SpyRecord = {
				run: process.env.PI_TODO_SPY_RUN ?? "unknown",
				request,
				count,
				messages,
				ts: new Date().toISOString(),
			};
			appendFileSync(out, `${JSON.stringify(record)}\n`);
		}
		// 不返回 payload：这是纯观察，不能改动请求。
		return undefined;
	});
}
