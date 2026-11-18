import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ApprovalDialogOptions,
	type ApprovalDialogPort,
	type ApprovalDialogRequest,
	NON_TUI_APPROVAL_DEADLINE_MS,
	runApprovalDialog,
} from "../src/approval-dialog";
import { APPROVAL_ALLOW, APPROVAL_DENY, DENIAL_REASON_PROMPT } from "../src/escalation";

const REQUEST: ApprovalDialogRequest = {
	title: "Allow this command?",
	options: [APPROVAL_DENY, APPROVAL_ALLOW],
	denialReason: DENIAL_REASON_PROMPT,
};

/** 永不应答的宿主：客户端把 extension_ui_request 静默丢弃后的真实形态。 */
function never<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

/**
 * 手写的 signal 桩：只实现 runApprovalDialog 用到的三件事，因此能精确断言
 * 「正常应答后外部 listener 被摘掉」——真 AbortSignal 的内部监听计数不可见。
 */
function fakeSignal() {
	let aborted = false;
	const listeners = new Set<() => void>();
	const signal = {
		get aborted() {
			return aborted;
		},
		addEventListener(type: string, listener: () => void) {
			if (type === "abort") listeners.add(listener);
		},
		removeEventListener(type: string, listener: () => void) {
			if (type === "abort") listeners.delete(listener);
		},
	} as unknown as AbortSignal;
	return {
		signal,
		abort() {
			if (aborted) return;
			aborted = true;
			for (const listener of [...listeners]) listener();
		},
		get listenerCount() {
			return listeners.size;
		},
	};
}

type PortBehavior = {
	mode?: string | undefined;
	select: (title: string, options: string[], opts: ApprovalDialogOptions) => Promise<string | undefined>;
	input?: (title: string, placeholder: string | undefined, opts: ApprovalDialogOptions) => Promise<string | undefined>;
};

/** 记录调用并按用例行为结算的弹窗宿主。 */
function fakePort(behavior: PortBehavior) {
	const select = vi.fn(behavior.select);
	const input = behavior.input === undefined ? undefined : vi.fn(behavior.input);
	const port: ApprovalDialogPort = { mode: () => behavior.mode, select, input };
	return { port, select, input };
}

/** 追踪 promise 是否已结算（不改变原 promise 的语义）。 */
function track<T>(promise: Promise<T>) {
	const state: { done: boolean; value: T | undefined } = { done: false, value: undefined };
	promise.then(
		(value) => {
			state.done = true;
			state.value = value;
		},
		() => {
			state.done = true;
		},
	);
	return state;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("runApprovalDialog：非 TUI 的本地 deadline", () => {
	it("宿主永不应答：deadline 前仍 pending，到点结算为 cancelled（不是 Deny）", async () => {
		vi.useFakeTimers();
		const { port } = fakePort({ mode: "rpc", select: () => never() });
		const state = track(runApprovalDialog(port, REQUEST));

		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS - 1);
		expect(state.done).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(state.done).toBe(true);
		expect(state.value).toEqual({ choice: undefined });
	});

	it("无外部 signal 时也向宿主传派生 signal 与 timeout", async () => {
		const { port, select } = fakePort({ mode: "rpc", select: async () => APPROVAL_ALLOW });
		await runApprovalDialog(port, REQUEST);
		const opts = select.mock.calls[0][2];
		expect(opts?.signal).toBeInstanceOf(AbortSignal);
		expect(opts?.timeout).toBe(NON_TUI_APPROVAL_DEADLINE_MS);
	});

	it("传给宿主的是派生 signal，不是调用方那个对象", async () => {
		const external = fakeSignal();
		const { port, select } = fakePort({ mode: "rpc", select: async () => APPROVAL_ALLOW });
		await runApprovalDialog(port, REQUEST, external.signal);
		expect(select.mock.calls[0][2]?.signal).not.toBe(external.signal);
	});

	it("mode 缺失（窄 ctx / 异常宿主）按非 TUI 处理：仍有 deadline", async () => {
		vi.useFakeTimers();
		const { port, select } = fakePort({ mode: undefined, select: () => never() });
		const state = track(runApprovalDialog(port, REQUEST));
		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS - 1);
		expect(state.done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(state.value).toEqual({ choice: undefined });
		expect(select.mock.calls[0][2]?.timeout).toBe(NON_TUI_APPROVAL_DEADLINE_MS);
	});

	it("mode() 抛错（stale ctx）按非 TUI 处理，不冒泡", async () => {
		const { port } = fakePort({ mode: "rpc", select: async () => APPROVAL_ALLOW });
		const hostile: ApprovalDialogPort = {
			mode: () => {
				throw new Error("This extension ctx is stale");
			},
			select: port.select,
		};
		await expect(runApprovalDialog(hostile, REQUEST)).resolves.toEqual({ choice: APPROVAL_ALLOW });
	});
});

describe("runApprovalDialog：TUI 不设默认上限", () => {
	it("假时钟推进超过默认值仍不自动结算，人工回答后正常完成", async () => {
		vi.useFakeTimers();
		let answer: ((value: string | undefined) => void) | undefined;
		const { port, select } = fakePort({
			mode: "tui",
			select: () =>
				new Promise<string | undefined>((resolve) => {
					answer = resolve;
				}),
		});
		const state = track(runApprovalDialog(port, REQUEST));

		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS * 4);
		expect(state.done).toBe(false);
		expect(select.mock.calls[0][2]?.timeout).toBeUndefined();

		if (answer === undefined) throw new Error("TUI dialog must be pending");
		answer(APPROVAL_ALLOW);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.value).toEqual({ choice: APPROVAL_ALLOW });
	});

	it("正常回答后本地 timer 全部清掉", async () => {
		vi.useFakeTimers();
		const { port } = fakePort({ mode: "rpc", select: async () => APPROVAL_ALLOW });
		await runApprovalDialog(port, REQUEST);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("runApprovalDialog：外部中断", () => {
	it("调用前已 abort：不打开弹窗，直接 cancelled", async () => {
		const external = fakeSignal();
		external.abort();
		const { port, select } = fakePort({ mode: "rpc", select: async () => APPROVAL_ALLOW });
		await expect(runApprovalDialog(port, REQUEST, external.signal)).resolves.toEqual({ choice: undefined });
		expect(select).not.toHaveBeenCalled();
	});

	it("在飞 abort（宿主完全忽略 signal）：本地仍能结算，并把中断传给宿主 signal", async () => {
		const external = fakeSignal();
		let hostSignal: AbortSignal | undefined;
		const { port } = fakePort({
			mode: "rpc",
			select: (_title, _options, opts) => {
				hostSignal = opts.signal;
				return never();
			},
		});
		const state = track(runApprovalDialog(port, REQUEST, external.signal));
		await vi.waitFor(() => expect(hostSignal).toBeDefined());

		external.abort();
		await vi.waitFor(() => expect(state.done).toBe(true));
		expect(state.value).toEqual({ choice: undefined });
		expect(hostSignal?.aborted).toBe(true);
	});

	it("宿主已应答、但中断先被记录 → cancelled（本地裁决优先于宿主结果）", async () => {
		const external = fakeSignal();
		const port: ApprovalDialogPort = {
			mode: () => "rpc",
			// 定制 thenable：把应答交给结算层之后（同一同步栈内）立即中断，复刻「应答与中断同一 tick 落地」。
			select: () =>
				({
					then(onFulfilled: (value: string) => void) {
						onFulfilled(APPROVAL_ALLOW);
						external.abort();
					},
				}) as unknown as Promise<string | undefined>,
		};
		await expect(runApprovalDialog(port, REQUEST, external.signal)).resolves.toEqual({ choice: undefined });
	});

	it("正常应答后摘掉外部 abort listener", async () => {
		const external = fakeSignal();
		const { port } = fakePort({ mode: "rpc", select: async () => APPROVAL_ALLOW });
		await runApprovalDialog(port, REQUEST, external.signal);
		expect(external.listenerCount).toBe(0);
	});
});

describe("runApprovalDialog：同步 reject 竞态（本地裁决拥有最终结算权）", () => {
	/** 复刻「宿主在 abort listener 里同步 reject」：本地裁决必须先落地，结果不能被改写成 generic error。 */
	function syncRejectOnAbort(): {
		select: (title: string, options: string[], opts: ApprovalDialogOptions) => Promise<string | undefined>;
		received: () => AbortSignal | undefined;
	} {
		let received: AbortSignal | undefined;
		return {
			received: () => received,
			select: (_title, _options, opts) => {
				received = opts.signal;
				return new Promise<string | undefined>((_resolve, reject) => {
					opts.signal.addEventListener("abort", () => reject(new Error("host rejected synchronously on abort")), { once: true });
				});
			},
		};
	}

	it("deadline 到期 + 宿主同步 reject → cancelled（不是 reject）", async () => {
		vi.useFakeTimers();
		const { port } = fakePort({ mode: "rpc", select: syncRejectOnAbort().select });
		const state = track(runApprovalDialog(port, REQUEST));
		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS);
		expect(state.done).toBe(true);
		expect(state.value).toEqual({ choice: undefined });
	});

	it("外部 abort + 宿主同步 reject → cancelled（不是 reject）", async () => {
		const external = fakeSignal();
		const { port, select } = fakePort({ mode: "rpc", select: syncRejectOnAbort().select });
		const state = track(runApprovalDialog(port, REQUEST, external.signal));
		await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
		external.abort();
		await vi.waitFor(() => expect(state.done).toBe(true));
		expect(state.value).toEqual({ choice: undefined });
	});
});

describe("runApprovalDialog：迟到结果", () => {
	it("deadline 到期后的迟到 Allow once 不获批", async () => {
		vi.useFakeTimers();
		let answer: ((value: string | undefined) => void) | undefined;
		const { port } = fakePort({
			mode: "rpc",
			select: () =>
				new Promise<string | undefined>((resolve) => {
					answer = resolve;
				}),
		});
		const state = track(runApprovalDialog(port, REQUEST));
		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS);
		expect(state.value).toEqual({ choice: undefined });

		if (answer === undefined) throw new Error("dialog must be pending for the late answer");
		answer(APPROVAL_ALLOW);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.value).toEqual({ choice: undefined });
	});

	it("迟到 reject 不产生 unhandled rejection（宿主 promise 立即被订阅）", async () => {
		vi.useFakeTimers();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			let rejectHost: ((error: Error) => void) | undefined;
			const { port } = fakePort({
				mode: "rpc",
				select: () =>
					new Promise<string | undefined>((_resolve, reject) => {
						rejectHost = reject;
					}),
			});
			const state = track(runApprovalDialog(port, REQUEST));
			await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS);
			expect(state.value).toEqual({ choice: undefined });

			vi.useRealTimers();
			if (rejectHost === undefined) throw new Error("host promise must be subscribed before the deadline");
			rejectHost(new Error("late host failure"));
			// 真实事件循环窗口：Node 在轮次末才判定未处理的 rejection，2 个宏任务足够。
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			vi.useRealTimers();
		}
	});
});

describe("runApprovalDialog：两步式（select → Deny 后可选 input）", () => {
	it("Deny → input 收到同一套派生 signal 与 timeout，返回理由", async () => {
		const { port, select, input } = fakePort({
			mode: "rpc",
			select: async () => APPROVAL_DENY,
			input: async () => "never touch ~/.aws",
		});
		await expect(runApprovalDialog(port, REQUEST)).resolves.toEqual({ choice: APPROVAL_DENY, reason: "never touch ~/.aws" });
		const selectOpts = select.mock.calls[0][2];
		const inputOpts = input?.mock.calls[0][2];
		expect(input).toHaveBeenCalledTimes(1);
		expect(input?.mock.calls[0][0]).toBe(DENIAL_REASON_PROMPT.title);
		expect(input?.mock.calls[0][1]).toBe(DENIAL_REASON_PROMPT.placeholder);
		expect(inputOpts?.timeout).toBe(NON_TUI_APPROVAL_DEADLINE_MS);
		expect(inputOpts?.signal).toBe(selectOpts?.signal);
	});

	it("Allow once → 不追问理由", async () => {
		const { port, input } = fakePort({ mode: "rpc", select: async () => APPROVAL_ALLOW, input: async () => "unused" });
		await runApprovalDialog(port, REQUEST);
		expect(input).not.toHaveBeenCalled();
	});

	it("理由步本地 deadline 到期 → 整次审批 cancelled（不退化成「Deny、无理由」）", async () => {
		vi.useFakeTimers();
		const { port } = fakePort({ mode: "rpc", select: async () => APPROVAL_DENY, input: () => never() });
		const state = track(runApprovalDialog(port, REQUEST));
		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS - 1);
		expect(state.done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(state.value).toEqual({ choice: undefined });
	});

	it("理由步外部 abort → 整次审批 cancelled", async () => {
		const external = fakeSignal();
		const { port, input } = fakePort({ mode: "rpc", select: async () => APPROVAL_DENY, input: () => never() });
		const state = track(runApprovalDialog(port, REQUEST, external.signal));
		// 必须等理由弹窗真的开出来再中断：否则用例可能在 select 阶段就 abort，测不到理由步。
		await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(1));
		expect(state.done).toBe(false);
		external.abort();
		await vi.waitFor(() => expect(state.done).toBe(true));
		expect(state.value).toEqual({ choice: undefined });
	});

	/** 复刻宿主在 abort listener 里同步 reject 的理由输入；本地裁决必须让它落成 cancelled 而不是 reject。 */
	function syncRejectInput(): {
		input: (title: string, placeholder: string | undefined, opts: ApprovalDialogOptions) => Promise<string | undefined>;
		received: () => AbortSignal | undefined;
	} {
		let received: AbortSignal | undefined;
		return {
			received: () => received,
			input: (_title, _placeholder, opts) => {
				received = opts.signal;
				return new Promise<string | undefined>((_resolve, reject) => {
					opts.signal.addEventListener("abort", () => reject(new Error("host rejected synchronously on abort")), { once: true });
				});
			},
		};
	}

	it("理由步 deadline 到期 + 宿主同步 reject → cancelled（不是 Deny、不是 reject）", async () => {
		vi.useFakeTimers();
		const { input } = syncRejectInput();
		const { port } = fakePort({ mode: "rpc", select: async () => APPROVAL_DENY, input });
		const state = track(runApprovalDialog(port, REQUEST));
		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS);
		expect(state.done).toBe(true);
		expect(state.value).toEqual({ choice: undefined });
	});

	it("理由步外部 abort + 宿主同步 reject → cancelled（不是 Deny、不是 reject）", async () => {
		const external = fakeSignal();
		const { input } = syncRejectInput();
		const { port, input: inputSpy } = fakePort({ mode: "rpc", select: async () => APPROVAL_DENY, input });
		const state = track(runApprovalDialog(port, REQUEST, external.signal));
		await vi.waitFor(() => expect(inputSpy).toHaveBeenCalledTimes(1));
		external.abort();
		await vi.waitFor(() => expect(state.done).toBe(true));
		expect(state.value).toEqual({ choice: undefined });
	});

	it("宿主取消理由（resolve undefined）/ 空理由 / input 异常 → Deny 无理由或原样理由", async () => {
		const cancelled = fakePort({ mode: "rpc", select: async () => APPROVAL_DENY, input: async () => undefined });
		await expect(runApprovalDialog(cancelled.port, REQUEST)).resolves.toEqual({ choice: APPROVAL_DENY });

		const blank = fakePort({ mode: "rpc", select: async () => APPROVAL_DENY, input: async () => "   " });
		await expect(runApprovalDialog(blank.port, REQUEST)).resolves.toEqual({ choice: APPROVAL_DENY, reason: "   " });

		const broken = fakePort({
			mode: "rpc",
			select: async () => APPROVAL_DENY,
			input: async () => {
				throw new Error("input dialog exploded");
			},
		});
		await expect(runApprovalDialog(broken.port, REQUEST)).resolves.toEqual({ choice: APPROVAL_DENY });
	});

	it("通道没有 input → Deny 直接结算，不报错", async () => {
		const { port } = fakePort({ mode: "rpc", select: async () => APPROVAL_DENY });
		await expect(runApprovalDialog(port, REQUEST)).resolves.toEqual({ choice: APPROVAL_DENY });
	});
});

describe("runApprovalDialog：并发隔离", () => {
	it("两个审批 session 互不取消：一个到期后另一个仍可人工回答", async () => {
		vi.useFakeTimers();
		let slowAnswer: ((value: string | undefined) => void) | undefined;
		const expiring = fakePort({ mode: "rpc", select: () => never() });
		const answered = fakePort({
			mode: "rpc",
			select: () =>
				new Promise<string | undefined>((resolve) => {
					slowAnswer = resolve;
				}),
		});
		const first = track(runApprovalDialog(expiring.port, REQUEST));
		// 错开启动：第二个 session 的 deadline 比第一个晚 OFFSET，才能区分"谁到期了"。
		const OFFSET = 100_000;
		await vi.advanceTimersByTimeAsync(OFFSET);
		const second = track(runApprovalDialog(answered.port, REQUEST));

		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS - OFFSET);
		expect(first.value).toEqual({ choice: undefined });
		expect(second.done).toBe(false);

		// 到期 session 的清理不得顺手取消另一个 session 的中断通道：人工回答后仍能正常结算。
		if (slowAnswer === undefined) throw new Error("second dialog must still be pending");
		slowAnswer(APPROVAL_ALLOW);
		await vi.advanceTimersByTimeAsync(0);
		expect(second.value).toEqual({ choice: APPROVAL_ALLOW });
	});

	it("同一宿主上两个 session 各自结算，结果对应", async () => {
		const answers = new Map<string, (value: string | undefined) => void>();
		const { port } = fakePort({
			mode: "rpc",
			select: (title) =>
				new Promise<string | undefined>((resolve) => {
					answers.set(title, resolve);
				}),
		});
		const first = runApprovalDialog(port, { ...REQUEST, title: "t1" });
		const second = runApprovalDialog(port, { ...REQUEST, title: "t2" });
		await vi.waitFor(() => expect(answers.size).toBe(2));
		answers.get("t1")?.(APPROVAL_DENY);
		answers.get("t2")?.(APPROVAL_ALLOW);
		// 理由步被宿主主动取消 → 只有 Deny，没有 reason 键（与既有「Deny、无理由」语义一致）
		await expect(first).resolves.toEqual({ choice: APPROVAL_DENY });
		await expect(second).resolves.toEqual({ choice: APPROVAL_ALLOW });
	});
});
