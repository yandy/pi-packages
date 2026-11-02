#!/usr/bin/env node
/**
 * pi-todo 看板漂移审计（A/B 对比用）。
 *
 * 它只读 session jsonl，不启动 pi、不调用任何模型，所以可以随时重跑。
 * 指标定义与 docs/superpowers/specs/2026-11-02-pi-todo-stale-board-reminder-design.md §1 一致，
 * 用同一套口径才能把「开启提醒前」和「开启提醒后」放在一张表里比。
 *
 * 用法：
 *   node scripts/todo-audit.ts                     # 扫 ~/.pi/agent/sessions
 *   node scripts/todo-audit.ts --dir /tmp/pi-todo-ab/on/sessions
 *   node scripts/todo-audit.ts --since 2026-11-05  # 只看这之后开始的会话（观察式 A/B）
 *   node scripts/todo-audit.ts --json
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- 只读文件系统工具（不引入依赖，脚本要能直接 node 跑） ----

interface TodoItem {
	id: string;
	title: string;
	status: "pending" | "in_progress" | "done";
}

interface TodoEvent {
	/** 这条调用所在的 assistant 轮次（从 1 开始）。 */
	turn: number;
	action: "set" | "update" | "list";
	args: Record<string, unknown>;
	/** 工具结果文本；工具报错时也算一次调用。 */
	text: string;
	/** 工具结果里的 details.todos（若宿主记录了）。 */
	todos: TodoItem[] | undefined;
}

interface SessionStats {
	file: string;
	startedAt: string;
	todoCalls: number;
	set: number;
	update: number;
	list: number;
	/** 计划里最多出现过多少条任务。 */
	maxItems: number;
	/** `done` 标记总数，以及其中「之前没有同一 id 的 in_progress」的数量。 */
	doneMarks: number;
	doneWithoutInProgress: number;
	/** 会话结束时看板上仍未完成的条数（用最后一次 todo 结果的 details 判定）。 */
	unfinishedAtEnd: number;
	totalAtEnd: number;
	/** 最后一次 todo 调用之后又跑了多少轮。 */
	turnsAfterLastTodo: number;
	/** 判据集合（见 spec §1）。 */
	noUpdate: boolean;
	planThenIdle: boolean;
	endedUnfinished: boolean;
}

/**
 * pi-todo 的 ack 形态；旧版内置 todo 只回裸 `OK`，用它把两类会话分开。
 * 注意：`<todo-reminder>` 不在其中 —— 提醒是请求级的、不落盘，见 spec §4.2。
 */
const ACK = /✓ all \d+ tasks done|◉ #|\(\d+\/\d+ done\)|· next: #|still in flight|ids renumbered/;

function* walkJsonl(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const path = join(dir, name);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(path);
		} catch {
			continue;
		}
		if (st.isDirectory()) yield* walkJsonl(path);
		else if (name.endsWith(".jsonl")) yield path;
	}
}

interface ContentBlock {
	type?: string;
	name?: string;
	id?: string;
	arguments?: Record<string, unknown>;
	text?: string;
}

/** session jsonl 的条目形状（只声明本脚本读到的字段）。 */
interface SessionEntry {
	type?: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		details?: { todos?: TodoItem[] };
	};
}

function parseSession(file: string): SessionStats | undefined {
	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}

	let startedAt = "";
	let turn = 0;
	const pending = new Map<string, { turn: number; args: Record<string, unknown> }>();
	const events: TodoEvent[] = [];

	for (const line of raw.split("\n")) {
		if (!line) continue;
		let entry: SessionEntry;
		try {
			entry = JSON.parse(line) as SessionEntry;
		} catch {
			continue;
		}
		if (entry.type === "session") {
			startedAt = entry.timestamp ?? "";
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message ?? {};
		const role = message.role;
		const content: unknown = message.content;

		if (role === "assistant") {
			turn += 1;
			if (!Array.isArray(content)) continue;
			for (const block of content as ContentBlock[]) {
				if (block?.type === "toolCall" && block.name === "todo") {
					pending.set(block.id as string, { turn, args: block.arguments ?? {} });
				}
			}
			continue;
		}

		if (role === "toolResult" && Array.isArray(content)) {
			const call = pending.get(message.toolCallId as string);
			if (!call) continue; // 不是 todo 的结果
			pending.delete(message.toolCallId as string);
			const text = (content as ContentBlock[])
				.filter((b) => typeof b?.text === "string")
				.map((b) => b.text)
				.join("");
			events.push({
				turn: call.turn,
				action: call.args.action as TodoEvent["action"],
				args: call.args,
				text,
				todos: message.details?.todos,
			});
		}
	}

	if (events.length === 0) return undefined;
	// 只统计真的用 pi-todo 的会话（ack 形态可辨），避免把旧版内置 todo 混进对照
	if (!events.some((e) => ACK.test(e.text))) return undefined;

	const stats: SessionStats = {
		file,
		startedAt,
		todoCalls: events.length,
		set: events.filter((e) => e.action === "set").length,
		update: events.filter((e) => e.action === "update").length,
		list: events.filter((e) => e.action === "list").length,
		maxItems: Math.max(0, ...events.filter((e) => e.action === "set").map((e) => (e.args.items as unknown[])?.length ?? 0)),
		doneMarks: 0,
		doneWithoutInProgress: 0,
		unfinishedAtEnd: 0,
		totalAtEnd: 0,
		turnsAfterLastTodo: Math.max(0, turn - events[events.length - 1].turn),
		noUpdate: false,
		planThenIdle: false,
		endedUnfinished: false,
	};

	const inProgress = new Set<string>();
	for (const e of events) {
		if (e.action !== "update") continue;
		const id = String(e.args.id ?? "").replace(/^#/, "");
		const status = e.args.status;
		if (status === "in_progress") inProgress.add(id);
		if (status === "done") {
			stats.doneMarks += 1;
			if (!inProgress.has(id)) stats.doneWithoutInProgress += 1;
		}
	}

	const final = events[events.length - 1].todos ?? [];
	stats.totalAtEnd = final.length;
	stats.unfinishedAtEnd = final.filter((t) => t.status !== "done").length;
	stats.noUpdate = stats.update === 0;
	stats.planThenIdle = stats.maxItems >= 3 && stats.update <= Math.floor(stats.maxItems / 3);
	stats.endedUnfinished = stats.unfinishedAtEnd > 0;
	return stats;
}

// ---- 汇总输出 ----

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const asJson = args.includes("--json");
const dir = flag("dir") ?? join(homedir(), ".pi", "agent", "sessions");
const since = flag("since") ? Date.parse(flag("since") as string) : undefined;

const sessions: SessionStats[] = [];
for (const file of walkJsonl(dir)) {
	const s = parseSession(file);
	if (!s) continue;
	if (since !== undefined && !(Date.parse(s.startedAt) >= since)) continue;
	sessions.push(s);
}

const sum = (pick: (s: SessionStats) => number) => sessions.reduce((a, s) => a + pick(s), 0);
const median = (values: number[]) => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const summary = {
	dir,
	since: since === undefined ? null : new Date(since).toISOString(),
	sessions: sessions.length,
	todoCalls: sum((s) => s.todoCalls),
	set: sum((s) => s.set),
	update: sum((s) => s.update),
	list: sum((s) => s.list),
	// 判据一：set 之后再没 update
	noUpdate: sessions.filter((s) => s.noUpdate).length,
	// 判据二：计划 ≥3 项但更新不到三分之一
	planThenIdle: sessions.filter((s) => s.planThenIdle).length,
	// 判据三：会话结束时板上仍有未完成项
	endedUnfinished: sessions.filter((s) => s.endedUnfinished).length,
	// 判据四：done 之前没有 in_progress（事后补账）
	doneMarks: sum((s) => s.doneMarks),
	doneWithoutInProgress: sum((s) => s.doneWithoutInProgress),
	doneWithoutInProgressRate: sum((s) => s.doneMarks) === 0 ? null : Number((sum((s) => s.doneWithoutInProgress) / sum((s) => s.doneMarks)).toFixed(3)),
	turnsAfterLastTodoMedian: median(sessions.map((s) => s.turnsAfterLastTodo)),
};

if (asJson) {
	console.log(JSON.stringify({ summary, sessions }, null, 2));
} else {
	const pct = (n: number) => (sessions.length === 0 ? "—" : `${Math.round((n / sessions.length) * 100)}%`);
	console.log(`pi-todo 会话：${dir}${since === undefined ? "" : `（since ${new Date(since).toISOString()}）`}`);
	console.log("");
	console.log(`  会话数                ${summary.sessions}`);
	console.log(`  todo 调用             ${summary.todoCalls}（set ${summary.set} / update ${summary.update} / list ${summary.list}）`);
	console.log("");
	console.log("  判据（spec §1/§5.3）");
	console.log(`  1. set 后从未 update         ${summary.noUpdate}/${summary.sessions}  ${pct(summary.noUpdate)}`);
	console.log(`  2. 计划 ≥3 项但更新 ≤ 1/3    ${summary.planThenIdle}/${summary.sessions}  ${pct(summary.planThenIdle)}`);
	console.log(`  3. 结束时板上仍有未完成      ${summary.endedUnfinished}/${summary.sessions}  ${pct(summary.endedUnfinished)}`);
	console.log(
		`  4. done 无前置 in_progress   ${summary.doneWithoutInProgress}/${summary.doneMarks}  ${
			summary.doneWithoutInProgressRate === null ? "—" : `${Math.round(summary.doneWithoutInProgressRate * 100)}%`
		}`,
	);
	console.log("");
	console.log(`  最后一次 todo 调用后仍跑了 ${summary.turnsAfterLastTodoMedian} 轮（中位）`);
}
