import { afterEach, describe, expect, it, vi } from "vitest";
import { getEscalationBroker, type ParentApprovalChannel, resetEscalationBrokerForTests } from "../src/escalation-broker";

/** 造一个父通道假件：hasUI 可切换，select/input 记录调用并返回固定值。 */
function fakeChannel(sessionId: string, hasUI = true, choice: string | undefined = "Allow once") {
	const select = vi.fn(async () => choice);
	const input = vi.fn(async (_title: string, _placeholder?: string) => "because");
	const channel: ParentApprovalChannel = { sessionId, hasUI: () => hasUI, select, input };
	return { channel, select, input };
}

afterEach(() => {
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
});

describe("request（FIFO + abort，spec §4.6）", () => {
	it("透传 title/options，返回用户选择；无 signal 时第三参为 undefined", async () => {
		const broker = getEscalationBroker();
		const { channel, select } = fakeChannel("parent-1");
		await expect(broker.request(channel, "T", ["Allow once", "Deny"])).resolves.toEqual({ choice: "Allow once" });
		expect(select).toHaveBeenCalledWith("T", ["Allow once", "Deny"], undefined);
	});

	it("有 signal 时以 opts.signal 透传（父弹窗可被中断关闭）", async () => {
		const broker = getEscalationBroker();
		const ac = new AbortController();
		let received: AbortSignal | undefined;
		const select = vi.fn(async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
			received = opts?.signal;
			return "Deny";
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select };
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], ac.signal)).resolves.toEqual({ choice: "Deny" });
		expect(received).toBe(ac.signal);
	});

	it("FIFO：前一个 settle 前不弹第二个，结果不串（Review Focus #5）", async () => {
		const broker = getEscalationBroker();
		const titles: string[] = [];
		const releases: ((value: string | undefined) => void)[] = [];
		const select = vi.fn((title: string) => new Promise<string | undefined>((resolve) => {
			titles.push(title);
			releases.push(resolve);
		}));
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select };
		const first = broker.request(channel, "t1", ["Allow once", "Deny"]);
		const second = broker.request(channel, "t2", ["Allow once", "Deny"]);
		await vi.waitFor(() => expect(titles).toEqual(["t1"]));
		releases[0]?.("Allow once");
		await expect(first).resolves.toEqual({ choice: "Allow once" });
		await vi.waitFor(() => expect(titles).toEqual(["t1", "t2"]));
		releases[1]?.("Deny");
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

	it("在飞时 abort → select 收到同一 signal，resolve undefined", async () => {
		const broker = getEscalationBroker();
		const ac = new AbortController();
		let received: AbortSignal | undefined;
		// 复刻 pi TUI 的真实行为：abort 时关闭弹窗并 resolve undefined
		const select = vi.fn((_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
			new Promise<string | undefined>((resolve) => {
				received = opts?.signal;
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			}));
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select };
		const pending = broker.request(channel, "T", ["Allow once", "Deny"], ac.signal);
		await vi.waitFor(() => expect(received).toBe(ac.signal));
		ac.abort();
		await expect(pending).resolves.toEqual({ choice: undefined });
	});

	it("父侧 select 抛错 → resolve undefined（按取消处理，不冒泡打断子代理工具调用）", async () => {
		const broker = getEscalationBroker();
		const select = vi.fn(async () => {
			throw new Error("ui exploded");
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select };
		await expect(broker.request(channel, "T", ["Allow once"])).resolves.toEqual({ choice: undefined });
	});

	it("前一个请求抛错不影响后续出队（Review Focus #5）", async () => {
		const broker = getEscalationBroker();
		let calls = 0;
		const select = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new Error("ui exploded");
			return "Allow once";
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select };
		await expect(broker.request(channel, "t1", ["Allow once"])).resolves.toEqual({ choice: undefined });
		await expect(broker.request(channel, "t2", ["Allow once"])).resolves.toEqual({ choice: "Allow once" });
	});
});

describe("resolveOwnChannel（本会话自己的通道，Ruling 17）", () => {
	it("已注册且 hasUI() 为真 → 返回自己", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("self");
		broker.registerParent(channel);
		expect(broker.resolveOwnChannel("self")).toBe(channel);
	});

	it("未注册 → null", () => {
		expect(getEscalationBroker().resolveOwnChannel("nobody")).toBeNull();
	});

	it("已注册但 hasUI() 为假 → null", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("self", false);
		broker.registerParent(channel);
		expect(broker.resolveOwnChannel("self")).toBeNull();
	});

	it("hasUI() 抛错 → null，不冒泡（fail-closed，Minor 4）", () => {
		const broker = getEscalationBroker();
		broker.registerParent({
			sessionId: "boom",
			hasUI: () => {
				throw new Error("This extension ctx is stale");
			},
			select: async () => undefined,
		});
		broker.linkChild("c", "boom");
		expect(broker.resolveChannel("c")).toBeNull();
		expect(broker.resolveOwnChannel("boom")).toBeNull();
	});

	it("不走 link：本会话即使有 link 也只按 sessionId 命中自己", () => {
		const broker = getEscalationBroker();
		const { channel: parent } = fakeChannel("parent");
		broker.registerParent(parent);
		broker.linkChild("self", "parent");
		expect(broker.resolveOwnChannel("self")).toBeNull();
		expect(broker.resolveChannel("self")).toBe(parent);
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

describe("request：Deny 理由的两步式（select + input 同 FIFO 任务）", () => {
	const reasonPrompt = { title: "Why deny?", placeholder: "optional" };

	it("Deny + denialReason + channel.input → 返回理由", async () => {
		const broker = getEscalationBroker();
		const { channel, input } = fakeChannel("p", true, "Deny");
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], undefined, reasonPrompt))
			.resolves.toEqual({ choice: "Deny", reason: "because" });
		expect(input).toHaveBeenCalledWith("Why deny?", "optional", undefined);
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
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select };
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], undefined, reasonPrompt)).resolves.toEqual({ choice: "Deny" });
	});

	it("input 抛错 → 返回 { choice: 'Deny' }（理由异常不影响拒绝语义，fail-closed）", async () => {
		const broker = getEscalationBroker();
		const select = vi.fn(async () => "Deny");
		const input = vi.fn(async () => {
			throw new Error("ui exploded");
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select, input };
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
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select, input };
		await broker.request(channel, "T", ["Allow once", "Deny"], ac.signal, reasonPrompt);
		expect(inputSignal).toBe(ac.signal);
	});

	it("FIFO 原子性：A 的理由输入未 settle 前，B 不得弹出 select（宿主只有一个对话框槽位）", async () => {
		const broker = getEscalationBroker();
		const events: string[] = [];
		let releaseInput: ((value: string | undefined) => void) | undefined;
		const input = vi.fn((title: string) => {
			events.push(`input:${title}`);
			return new Promise<string | undefined>((resolve) => {
				releaseInput = resolve;
			});
		});
		const select = vi.fn(async (title: string) => {
			events.push(`select:${title}`);
			return "Deny";
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select, input };
		const first = broker.request(channel, "t1", ["Allow once", "Deny"], undefined, reasonPrompt);
		const second = broker.request(channel, "t2", ["Allow once", "Deny"], undefined, reasonPrompt);
		await vi.waitFor(() => expect(events).toEqual(["select:t1", "input:Why deny?"]));
		expect(select).toHaveBeenCalledTimes(1);
		releaseInput?.("r1");
		await expect(first).resolves.toEqual({ choice: "Deny", reason: "r1" });
		await vi.waitFor(() => expect(events).toEqual(["select:t1", "input:Why deny?", "select:t2", "input:Why deny?"]));
		releaseInput?.("r2");
		await expect(second).resolves.toEqual({ choice: "Deny", reason: "r2" });
	});
});
