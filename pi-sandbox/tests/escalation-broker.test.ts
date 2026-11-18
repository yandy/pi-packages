import { afterEach, describe, expect, it, vi } from "vitest";
import { NON_TUI_APPROVAL_DEADLINE_MS } from "../src/approval-dialog";
import { getEscalationBroker, type ParentApprovalChannel, resetEscalationBrokerForTests } from "../src/escalation-broker";

/** 造一个父通道假件：hasUI 可切换，select/input 记录调用并返回固定值。
 *  mode 是父会话的实际宿主模式（broker 用它决定要不要武装本地 deadline）。 */
function fakeChannel(sessionId: string, hasUI = true, choice: string | undefined = "Allow once", mode = "rpc") {
	const select = vi.fn(async () => choice);
	const input = vi.fn(async (_title: string, _placeholder?: string) => "because");
	const channel: ParentApprovalChannel = { sessionId, hasUI: () => hasUI, mode: () => mode, select, input };
	return { channel, select, input };
}

afterEach(() => {
	vi.useRealTimers();
	// 模块级全局槽位跨测试复位（testing.md：模块单例必须显式复位）
	resetEscalationBrokerForTests();
});

describe("getEscalationBroker", () => {
	it("globalThis 单例：重复调用同一对象，reset 后换新对象", () => {
		const first = getEscalationBroker();
		expect(getEscalationBroker()).toBe(first);
		resetEscalationBrokerForTests();
		expect(getEscalationBroker()).not.toBe(first);
	});
});

describe("resolveChannel（严格路由，spec §2 D3）", () => {
	it("link + 已注册父 → 命中父通道", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("parent-1");
		broker.registerParent(channel);
		broker.linkChild("child-1", "parent-1");
		expect(broker.resolveChannel("child-1")).toBe(channel);
	});

	it("无 link → null（Review Focus #4：不猜进程内唯一的交互会话）", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("parent-1");
		broker.registerParent(channel);
		expect(broker.resolveChannel("orphan")).toBeNull();
	});

	it("父已注销（session_shutdown 后）→ null（Review Focus #4）", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("parent-1");
		broker.registerParent(channel);
		broker.linkChild("child-1", "parent-1");
		broker.unregisterParent("parent-1");
		expect(broker.resolveChannel("child-1")).toBeNull();
	});

	it("父注册但 hasUI() 为 false → null（Review Focus #4）", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("parent-1", false);
		broker.registerParent(channel);
		broker.linkChild("child-1", "parent-1");
		expect(broker.resolveChannel("child-1")).toBeNull();
	});

	it("child 已 disposed（unlink）→ null", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("parent-1");
		broker.registerParent(channel);
		broker.linkChild("child-1", "parent-1");
		broker.unlinkChild("child-1");
		expect(broker.resolveChannel("child-1")).toBeNull();
	});

	it("depth-2：跳过未注册通道的中间会话，命中顶层父", () => {
		const broker = getEscalationBroker();
		const { channel: top } = fakeChannel("top");
		broker.registerParent(top);
		broker.linkChild("mid", "top");
		broker.linkChild("leaf", "mid");
		expect(broker.resolveChannel("leaf")).toBe(top);
	});

	it("depth-2：中间会话已注册但无 UI → 继续向上", () => {
		const broker = getEscalationBroker();
		const { channel: top } = fakeChannel("top");
		const { channel: mid } = fakeChannel("mid", false);
		broker.registerParent(top);
		broker.registerParent(mid);
		broker.linkChild("mid", "top");
		broker.linkChild("leaf", "mid");
		expect(broker.resolveChannel("leaf")).toBe(top);
	});

	it("link 成环 → null，不死循环（Review Focus #3）", () => {
		const broker = getEscalationBroker();
		broker.linkChild("a", "b");
		broker.linkChild("b", "a");
		expect(broker.resolveChannel("a")).toBeNull();
	});

	it("自环 → null（Review Focus #3）", () => {
		const broker = getEscalationBroker();
		broker.linkChild("a", "a");
		expect(broker.resolveChannel("a")).toBeNull();
	});

	it("超长祖先链（> 32 层）→ null，不死循环（Review Focus #3）", () => {
		const broker = getEscalationBroker();
		for (let i = 0; i < 40; i++) {
			broker.linkChild(`s${i}`, `s${i + 1}`);
		}
		expect(broker.resolveChannel("s0")).toBeNull();
	});

	it("linkChild 缺 parentSessionId → 不建立 link", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("parent-1");
		broker.registerParent(channel);
		broker.linkChild("child-1", undefined);
		expect(broker.resolveChannel("child-1")).toBeNull();
	});

	it("空 sessionId 既不作为父注册，也不作为 link 父端", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("");
		broker.registerParent(channel);
		broker.linkChild("child-1", "");
		expect(broker.resolveChannel("child-1")).toBeNull();
	});

	it("已注册父的 hasUI() 抛错 → null，不冒泡（fail-closed）", () => {
		const broker = getEscalationBroker();
		broker.registerParent({
			sessionId: "boom",
			hasUI: () => {
				throw new Error("This extension ctx is stale");
			},
			mode: () => "rpc",
			select: async () => undefined,
		});
		broker.linkChild("c", "boom");
		expect(broker.resolveChannel("c")).toBeNull();
	});
});

describe("request（并发结算 + abort）", () => {
	it("透传 title/options，返回用户选择；无外部 signal 时仍传派生 signal 与 timeout", async () => {
		const broker = getEscalationBroker();
		const { channel, select } = fakeChannel("parent-1");
		await expect(broker.request(channel, "T", ["Allow once", "Deny"])).resolves.toEqual({ choice: "Allow once" });
		expect(select).toHaveBeenCalledTimes(1);
		const opts = select.mock.calls[0][2];
		expect(opts?.signal).toBeInstanceOf(AbortSignal);
		expect(opts?.timeout).toBe(NON_TUI_APPROVAL_DEADLINE_MS);
	});

	it("有 signal 时派生 signal 承接中断（父弹窗可被关闭），且不是调用方那个对象", async () => {
		const broker = getEscalationBroker();
		const ac = new AbortController();
		let received: AbortSignal | undefined;
		const select = vi.fn(async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
			received = opts?.signal;
			return "Deny";
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, mode: () => "rpc", select };
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], ac.signal)).resolves.toEqual({ choice: "Deny" });
		expect(received).toBeInstanceOf(AbortSignal);
		expect(received).not.toBe(ac.signal);
	});

	it("两个并发 request 各自结算且结果对应，不承诺顺序", async () => {
		const broker = getEscalationBroker();
		const releases = new Map<string, (value: string | undefined) => void>();
		const select = vi.fn((title: string) => new Promise<string | undefined>((resolve) => {
			releases.set(title, resolve);
		}));
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, mode: () => "rpc", select };
		const first = broker.request(channel, "t1", ["Allow once", "Deny"]);
		const second = broker.request(channel, "t2", ["Allow once", "Deny"]);
		// 两个 select 都必须先进入在飞状态；任一请求等待另一个 settle 都会在这里超时。
		await vi.waitFor(() => expect(releases.size).toBe(2));
		const releaseFirst = releases.get("t1");
		const releaseSecond = releases.get("t2");
		if (releaseFirst === undefined || releaseSecond === undefined) throw new Error("both deferred selects must be pending");
		releaseFirst("Allow once");
		releaseSecond("Deny");
		await expect(first).resolves.toEqual({ choice: "Allow once" });
		await expect(second).resolves.toEqual({ choice: "Deny" });
	});

	it("signal 已 abort → 不调 select，resolve undefined（Review Focus #2：不弹幽灵审批）", async () => {
		const broker = getEscalationBroker();
		const { channel, select } = fakeChannel("parent-1");
		const ac = new AbortController();
		ac.abort();
		await expect(broker.request(channel, "T", ["Allow once"], ac.signal)).resolves.toEqual({ choice: undefined });
		expect(select).not.toHaveBeenCalled();
	});

	it("在飞时 abort → 派生 signal 被中断，resolve undefined", async () => {
		const broker = getEscalationBroker();
		const ac = new AbortController();
		let received: AbortSignal | undefined;
		// 复刻 pi TUI 的真实行为：abort 时关闭弹窗并 resolve undefined
		const select = vi.fn((_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
			new Promise<string | undefined>((resolve) => {
				received = opts?.signal;
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			}));
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, mode: () => "rpc", select };
		const pending = broker.request(channel, "T", ["Allow once", "Deny"], ac.signal);
		await vi.waitFor(() => expect(received).toBeInstanceOf(AbortSignal));
		expect(received).not.toBe(ac.signal);
		ac.abort();
		await expect(pending).resolves.toEqual({ choice: undefined });
		expect(received?.aborted).toBe(true);
	});

	it("父侧 select 抛错 → resolve undefined（按取消处理，不冒泡打断子代理工具调用）", async () => {
		const broker = getEscalationBroker();
		const select = vi.fn(async () => {
			throw new Error("ui exploded");
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, mode: () => "rpc", select };
		await expect(broker.request(channel, "T", ["Allow once"])).resolves.toEqual({ choice: undefined });
	});

	it("一次 select 抛错不影响下一次请求", async () => {
		const broker = getEscalationBroker();
		let calls = 0;
		const select = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new Error("ui exploded");
			return "Allow once";
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, mode: () => "rpc", select };
		await expect(broker.request(channel, "t1", ["Allow once"])).resolves.toEqual({ choice: undefined });
		await expect(broker.request(channel, "t2", ["Allow once"])).resolves.toEqual({ choice: "Allow once" });
	});
});

describe("request 的\"从不 reject\"契约：抛错取值器（review I1）", () => {
	it("通道 input 是抛错取值器 → 仍是「Deny、无理由」，不 reject、不降级成取消", async () => {
		const broker = getEscalationBroker();
		const select = vi.fn(async () => "Deny");
		const channel = {
			sessionId: "p",
			hasUI: () => true,
			mode: () => "rpc",
			select,
			get input(): (title: string, placeholder?: string) => Promise<string | undefined> {
				throw new Error("hostile input getter");
			},
		} as unknown as ParentApprovalChannel;
		await expect(broker.request(channel, "T", ["Deny", "Allow once"], undefined, { title: "Why deny?", placeholder: "optional" }))
			.resolves.toEqual({ choice: "Deny" });
	});

	it("通道 select 是抛错取值器 → 按取消结算，不 reject", async () => {
		const broker = getEscalationBroker();
		const channel = {
			sessionId: "p",
			hasUI: () => true,
			mode: () => "rpc",
			get select(): (title: string, options: string[]) => Promise<string | undefined> {
				throw new Error("hostile select getter");
			},
		} as unknown as ParentApprovalChannel;
		await expect(broker.request(channel, "T", ["Deny", "Allow once"])).resolves.toEqual({ choice: undefined });
	});

	it("通道 mode 是抛错取值器 → 按非 TUI 处理（有 deadline），请求照常结算", async () => {
		const broker = getEscalationBroker();
		const select = vi.fn(async () => "Allow once");
		const channel = {
			sessionId: "p",
			hasUI: () => true,
			get mode(): () => string | undefined {
				throw new Error("hostile mode getter");
			},
			select,
		} as unknown as ParentApprovalChannel;
		await expect(broker.request(channel, "T", ["Deny", "Allow once"])).resolves.toEqual({ choice: "Allow once" });
		expect(select.mock.calls[0][2]?.timeout).toBe(NON_TUI_APPROVAL_DEADLINE_MS);
	});
});

describe("request 的\"从不 reject\"契约（病态输入，Minor 5）", () => {
	it("signal 的 aborted getter 抛错 → resolve undefined，不 reject", async () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("p");
		const hostile = {
			get aborted(): boolean {
				throw new Error("hostile signal");
			},
		} as AbortSignal;
		await expect(broker.request(channel, "T", ["Allow once"], hostile)).resolves.toEqual({ choice: undefined });
	});
});

describe("request：Deny 理由的两步式（select → input 串行）", () => {
	const reasonPrompt = { title: "Why deny?", placeholder: "optional" };

	it("Deny + denialReason + channel.input → 返回理由", async () => {
		const broker = getEscalationBroker();
		const { channel, input } = fakeChannel("p", true, "Deny");
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], undefined, reasonPrompt))
			.resolves.toEqual({ choice: "Deny", reason: "because" });
		expect(input).toHaveBeenCalledTimes(1);
		expect(input.mock.calls[0][0]).toBe("Why deny?");
		expect(input.mock.calls[0][1]).toBe("optional");
		expect(input.mock.calls[0][2]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("Allow once → 不追问理由（input 零调用）", async () => {
		const broker = getEscalationBroker();
		const { channel, input } = fakeChannel("p", true, "Allow once");
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], undefined, reasonPrompt)).resolves.toEqual({ choice: "Allow once" });
		expect(input).not.toHaveBeenCalled();
	});

	it("channel 无 input → 返回 { choice: 'Deny' }（理由缺失不阻塞拒绝）", async () => {
		const broker = getEscalationBroker();
		const select = vi.fn(async () => "Deny");
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, mode: () => "rpc", select };
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], undefined, reasonPrompt)).resolves.toEqual({ choice: "Deny" });
	});

	it("input 抛错 → 返回 { choice: 'Deny' }（理由异常不影响拒绝语义，fail-closed）", async () => {
		const broker = getEscalationBroker();
		const select = vi.fn(async () => "Deny");
		const input = vi.fn(async () => {
			throw new Error("ui exploded");
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, mode: () => "rpc", select, input };
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], undefined, reasonPrompt)).resolves.toEqual({ choice: "Deny" });
	});

	it("signal abort 透传到 input（在飞时关闭理由弹窗）", async () => {
		const broker = getEscalationBroker();
		const ac = new AbortController();
		let inputSignal: AbortSignal | undefined;
		const select = vi.fn(async () => "Deny");
		const input = vi.fn(async (_t: string, _p: string | undefined, opts?: { signal?: AbortSignal }) => {
			inputSignal = opts?.signal;
			return "ok";
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, mode: () => "rpc", select, input };
		await broker.request(channel, "T", ["Allow once", "Deny"], ac.signal, reasonPrompt);
		expect(inputSignal).toBeInstanceOf(AbortSignal);
		expect(inputSignal).not.toBe(ac.signal);
		expect(inputSignal?.aborted).toBe(false);
	});

	it("同一 request 内 select → input 串行，理由输入不被并发请求打断", async () => {
		const broker = getEscalationBroker();
		const events: string[] = [];
		const inputReleases = new Map<string, (value: string | undefined) => void>();
		const input = vi.fn((title: string) => {
			events.push(`input:${title}`);
			return new Promise<string | undefined>((resolve) => {
				inputReleases.set(title, resolve);
			});
		});
		const select = vi.fn(async (title: string) => {
			events.push(`select:${title}`);
			return "Deny";
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, mode: () => "rpc", select, input };
		const first = broker.request(channel, "t1", ["Allow once", "Deny"], undefined, { title: "Why deny t1?" });
		const second = broker.request(channel, "t2", ["Allow once", "Deny"], undefined, { title: "Why deny t2?" });
		// 两个理由输入可同时处于在飞状态；这里不比较不同 request 的事件先后。
		await vi.waitFor(() => expect(inputReleases.size).toBe(2));
		for (const title of ["t1", "t2"]) {
			expect(events).toContain(`select:${title}`);
			expect(events.indexOf(`select:${title}`)).toBeLessThan(events.indexOf(`input:Why deny ${title}?`));
		}
		const releaseFirst = inputReleases.get("Why deny t1?");
		const releaseSecond = inputReleases.get("Why deny t2?");
		if (releaseFirst === undefined || releaseSecond === undefined) throw new Error("both denial reasons must be pending");
		releaseFirst("r1");
		releaseSecond("r2");
		await expect(first).resolves.toEqual({ choice: "Deny", reason: "r1" });
		await expect(second).resolves.toEqual({ choice: "Deny", reason: "r2" });
	});
});

describe("request：按父会话 mode 决定 deadline（issue #253）", () => {
	it("父会话是 rpc 且宿主永不应答：deadline 前 pending，到点结算为 cancelled", async () => {
		vi.useFakeTimers();
		const broker = getEscalationBroker();
		const { channel, select } = fakeChannel("p", true, undefined);
		select.mockImplementation(() => new Promise<string | undefined>(() => {}));
		const state: { done: boolean; value: { choice: unknown } | undefined } = { done: false, value: undefined };
		const pending = broker.request(channel, "T", ["Deny", "Allow once"]).then((value) => {
			state.done = true;
			state.value = value;
			return value;
		});

		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS - 1);
		expect(state.done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await pending;
		expect(state.value).toEqual({ choice: undefined });
	});

	it("父会话是 tui：假时钟推进超过默认值仍 pending，人工回答后正常结算", async () => {
		vi.useFakeTimers();
		const broker = getEscalationBroker();
		let release: ((value: string | undefined) => void) | undefined;
		const select = vi.fn((_title: string) => new Promise<string | undefined>((resolve) => {
			release = resolve;
		}));
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, mode: () => "tui", select };
		const pending = broker.request(channel, "T", ["Deny", "Allow once"]);
		expect(select.mock.calls[0][2]?.timeout).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS * 4);
		vi.useRealTimers();
		if (release === undefined) throw new Error("TUI dialog must be pending");
		release("Allow once");
		await expect(pending).resolves.toEqual({ choice: "Allow once" });
	});

	it("宿主在 abort listener 里同步 reject → 仍是 cancelled（本地裁决优先）", async () => {
		vi.useFakeTimers();
		const broker = getEscalationBroker();
		const select = vi.fn(
			(_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
				new Promise<string | undefined>((_resolve, reject) => {
					opts?.signal?.addEventListener("abort", () => reject(new Error("host rejected synchronously")), { once: true });
				}),
		);
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, mode: () => "rpc", select };
		const pending = broker.request(channel, "T", ["Deny", "Allow once"]);
		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS);
		await expect(pending).resolves.toEqual({ choice: undefined });
	});

	it("理由输入步也拿到同一套 timeout（每次弹窗各自 300 秒，共用同一个中断通道）", async () => {
		const broker = getEscalationBroker();
		const { channel, input } = fakeChannel("p", true, "Deny");
		await broker.request(channel, "T", ["Deny", "Allow once"], undefined, { title: "Why deny?", placeholder: "optional" });
		expect(input.mock.calls[0][2]?.timeout).toBe(NON_TUI_APPROVAL_DEADLINE_MS);
	});

	it("两个并发 request 各自的 deadline 互不影响（按期结算的只有到点那个）", async () => {
		vi.useFakeTimers();
		const broker = getEscalationBroker();
		const answers = new Map<string, (value: string | undefined) => void>();
		const select = vi.fn((title: string) => new Promise<string | undefined>((resolve) => {
			answers.set(title, resolve);
		}));
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, mode: () => "rpc", select };
		const first = broker.request(channel, "t1", ["Deny", "Allow once"]);
		const second = broker.request(channel, "t2", ["Deny", "Allow once"]);
		await vi.waitFor(() => expect(answers.size).toBe(2));
		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS);
		await expect(first).resolves.toEqual({ choice: undefined });
		await expect(second).resolves.toEqual({ choice: undefined });
	});
});
