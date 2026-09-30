import { afterEach, describe, expect, it, vi } from "vitest";
import { getEscalationBroker, type ParentApprovalChannel, resetEscalationBrokerForTests } from "../src/escalation-broker";

/** 造一个父通道假件：hasUI 可切换，select 记录调用并返回固定选择。 */
function fakeChannel(sessionId: string, hasUI = true, choice: string | undefined = "Allow once") {
	const select = vi.fn(async () => choice);
	const channel: ParentApprovalChannel = { sessionId, hasUI: () => hasUI, select };
	return { channel, select };
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
