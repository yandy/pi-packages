import { clipTitle, isBlocked, pickNext, type TodoItem } from "./todo-store.js";

/**
 * 第一次提醒前允许静默的轮数。
 *
 * 依据（40 个真实 pi-todo 会话的实测）：模型从标 in_progress 到标 done 的跨度中位数是 7 个
 * assistant 轮。取 5 是为了在「模型本来会把任务关掉」之前至少提醒一次，而不是在它正埋头做
 * 这一个任务时反复打断。
 */
export const FIRST_REMINDER_TURNS = 5;

/** 每次提醒后间隔翻倍，并封顶在这里：长 run 里最多每 40 轮一次，不会变成刷屏。 */
export const MAX_REMINDER_INTERVAL_TURNS = 40;

/** 一条提醒里最多点名的在飞任务数（其余折叠成 `+N`）。 */
const MAX_IN_FLIGHT_NAMES = 2;

/**
 * 决定「现在该不该提醒」的计时器。
 *
 * 它只关心两件事：距上一次 todo 调用过了多少个 assistant 轮，以及上一次提醒之后该等多久
 * （指数退避）。板子本身的状态由调用方传给 {@link formatReminder}，这里不做判断。
 */
export class ReminderScheduler {
	private turns = 0;
	private interval = FIRST_REMINDER_TURNS;

	/** 模型碰过板子（任何 action，含报错）：重新计时并把退避打回基线。 */
	onTodoCall(): void {
		this.turns = 0;
		this.interval = FIRST_REMINDER_TURNS;
	}

	/** 一个 assistant 轮结束。 */
	onTurn(): void {
		this.turns += 1;
	}

	/**
	 * 到期时返回已经静默的轮数并重新计时；未到期返回 undefined。
	 *
	 * 「取走」语义是刻意的：调用方拿到轮数后如果发现板子没什么可催的，这一次提醒就作废，
	 * 而不是留在队列里等下一轮继续触发 —— 否则空板会一直挂着一次待发的提醒。
	 */
	takeDue(): number | undefined {
		if (this.turns < this.interval) return undefined;
		const stale = this.turns;
		this.turns = 0;
		this.interval = Math.min(this.interval * 2, MAX_REMINDER_INTERVAL_TURNS);
		return stale;
	}
}

/**
 * 生成一条模型可见的提醒，或返回 undefined（无开放任务 / 全部阻塞）。
 *
 * 措辞刻意与 T3-B 的快照注入区分开（见 docs/superpowers/specs/2026-10-10-pi-todo-update-discipline-design.md
 * 决策变更三）：它不断言「现在的看板是什么样」，只说「你已经 N 轮没更新了」并给出该做的调用，
 * 所以即使另一条更新在别处生效，这条提醒也不会冒充成更新后的状态。用 XML 标签包裹是为了让
 * 模型认出它不是用户的新请求。
 */
export function formatReminder(todos: TodoItem[], staleTurns: number): string | undefined {
	const open = todos.filter((t) => t.status !== "done");
	if (open.length === 0) return undefined;
	// 全被依赖挡住：没有可推进的任务，催了只会让模型去动不该动的东西。
	if (open.every((t) => isBlocked(todos, t))) return undefined;

	const inFlight = open.filter((t) => t.status === "in_progress");
	const head = `<todo-reminder>The pi-todo board has not been updated for ${staleTurns} turns`;

	if (inFlight.length > 0) {
		const names = inFlight
			.slice(0, MAX_IN_FLIGHT_NAMES)
			.map((t) => `#${t.id} ${clipTitle(t.title)}`)
			.join(", ");
		const more = inFlight.length > MAX_IN_FLIGHT_NAMES ? ` +${inFlight.length - MAX_IN_FLIGHT_NAMES}` : "";
		return (
			`${head}. Still in_progress: ${names}${more}. ` +
			`When one of them is finished, call todo action "update" with its id and status "done" right away — ` +
			"do not batch completions to the end of the run.</todo-reminder>"
		);
	}

	const next = pickNext(todos);
	const nextNote = next ? ` Next up: #${next.id} ${clipTitle(next.title)}.` : "";
	return (
		`${head} and nothing is in_progress. ` +
		`Mark the task you are working on with todo action "update" and status "in_progress", ` +
		`and mark each task done as it passes.${nextNote}</todo-reminder>`
	);
}
