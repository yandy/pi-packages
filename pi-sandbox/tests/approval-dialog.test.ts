import { afterEach, describe, expect, it, vi } from "vitest";
import {
	APPROVAL_DIALOG_DEFAULT_TIMEOUT_MS,
	type ApprovalDialogChannel,
	type ApprovalDialogOptions,
	dialogTimeoutMs,
	runApprovalDialog,
} from "../src/approval-dialog";
import type { DenialReasonPrompt } from "../src/escalation";

/** 结算闸门：记录 resolve/reject，供“迟到结果”判例手动拨动。 */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** 完全忽略 opts 的敌对宿主：既不听 signal，也不设 timeout（最坏情况）。 */
function deafChannel(selectOutcome: Promise<string | undefined>) {
	const select = vi.fn(() => selectOutcome);
	const channel: ApprovalDialogChannel = { select };
	return { channel, select };
}

const reasonPrompt: DenialReasonPrompt = { title: "Why deny?", placeholder: "optional" };

afterEach(() => {
	vi.useRealTimers();
});

describe("dialogTimeoutMs（非 TUI 默认 deadline，TUI 无上限）", () => {
	it("非 TUI 模式与未知模式都取 300_000ms（未知按非 TUI 兜底）", () => {
		expect(APPROVAL_DIALOG_DEFAULT_TIMEOUT_MS).toBe(300_000);
		expect(dialogTimeoutMs("rpc")).toBe(300_000);
		expect(dialogTimeoutMs("json")).toBe(300_000);
		expect(dialogTimeoutMs("print")).toBe(300_000);
		expect(dialogTimeoutMs(undefined)).toBe(300_000);
		expect(dialogTimeoutMs("something-else")).toBe(300_000);
	});
	it("TUI 不设默认上限（用户有 Esc/Ctrl-C，弹窗可以一直等）", () => {
		expect(dialogTimeoutMs("tui")).toBeUndefined();
	});
});

describe("runApprovalDialog：向宿主传派生 signal 与 timeout", () => {
	it("无外部 signal 时仍传派生 signal + timeout（宿主据此也可自行结算）", async () => {
		const select = vi.fn(async () => "Allow once");
		await runApprovalDialog({ select }, "T", ["Deny", "Allow once"], undefined, { timeoutMs: 300_000 });
		const opts = select.mock.calls[0][2] as ApprovalDialogOptions;
		expect(opts.timeout).toBe(300_000);
		expect(opts.signal).toBeInstanceOf(AbortSignal);
	});
	it("TUI：不传 timeout，仍传派生 signal（在飞 abort 能关闭弹窗）", async () => {
		const select = vi.fn(async () => "Allow once");
		await runApprovalDialog({ select }, "T", ["Deny", "Allow once"], undefined, { timeoutMs: undefined });
		const opts = select.mock.calls[0][2] as ApprovalDialogOptions;
		expect(opts.timeout).toBeUndefined();
		expect(opts.signal).toBeInstanceOf(AbortSignal);
	});
	it("外部 signal 的 abort 传播到派生 signal（宿主即便忽略 opts 也能被本地结算）", async () => {
		const ac = new AbortController();
		let derived: AbortSignal | undefined;
		const select = vi.fn((_t: string, _o: string[], opts?: ApprovalDialogOptions) => {
			derived = opts?.signal;
			return new Promise<string | undefined>(() => {});
		});
		const pending = runApprovalDialog({ select }, "T", ["Deny", "Allow once"], undefined, { signal: ac.signal });
		await vi.waitFor(() => expect(derived).toBeDefined());
		ac.abort();
		await expect(pending).resolves.toEqual({ choice: undefined });
		expect(derived?.aborted).toBe(true);
	});
});

describe("runApprovalDialog：本地 deadline 与 abort 结算", () => {
	it("敌对宿主永不应答：N-1ms 仍 pending，Nms 结算为取消", async () => {
		vi.useFakeTimers();
		const { channel } = deafChannel(new Promise<string | undefined>(() => {}));
		const pending = runApprovalDialog(channel, "T", ["Deny", "Allow once"], undefined, { timeoutMs: 300_000 });
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(299_999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toEqual({ choice: undefined });
	});

	it("调用前已 abort：根本不调用 select", async () => {
		const ac = new AbortController();
		ac.abort();
		const { channel, select } = deafChannel(new Promise<string | undefined>(() => {}));
		await expect(runApprovalDialog(channel, "T", ["Deny", "Allow once"], undefined, { signal: ac.signal, timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: undefined });
		expect(select).not.toHaveBeenCalled();
	});

	it("在飞 abort + 宿主忽略 opts：本地结算为取消", async () => {
		const ac = new AbortController();
		const { channel } = deafChannel(new Promise<string | undefined>(() => {}));
		const pending = runApprovalDialog(channel, "T", ["Deny", "Allow once"], undefined, { signal: ac.signal, timeoutMs: 300_000 });
		ac.abort();
		await expect(pending).resolves.toEqual({ choice: undefined });
	});

	it("同步 reject 竞态：宿主在 abort listener 里同步 reject，结果仍是取消而不是 generic error", async () => {
		const ac = new AbortController();
		const select = vi.fn((_t: string, _o: string[], opts?: ApprovalDialogOptions) =>
			new Promise<string | undefined>((_resolve, reject) => {
				opts?.signal?.addEventListener("abort", () => reject(new Error("host rejected on abort")));
			}));
		const pending = runApprovalDialog({ select }, "T", ["Deny", "Allow once"], undefined, { signal: ac.signal, timeoutMs: 300_000 });
		ac.abort();
		await expect(pending).resolves.toEqual({ choice: undefined });
	});

	it("timeout 触发的同步 reject 同样是取消（不是宿主错误）", async () => {
		vi.useFakeTimers();
		const select = vi.fn((_t: string, _o: string[], opts?: ApprovalDialogOptions) =>
			new Promise<string | undefined>((_resolve, reject) => {
				opts?.signal?.addEventListener("abort", () => reject(new Error("host rejected on timeout")));
			}));
		const pending = runApprovalDialog({ select }, "T", ["Deny", "Allow once"], undefined, { timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).resolves.toEqual({ choice: undefined });
	});

	it("迟到结果：超时后迟到的 Allow once 不会被采纳；迟到 reject 不产生未处理拒绝", async () => {
		vi.useFakeTimers();
		const gate = deferred<string | undefined>();
		const { channel } = deafChannel(gate.promise);
		const pending = runApprovalDialog(channel, "T", ["Deny", "Allow once"], undefined, { timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).resolves.toEqual({ choice: undefined });
		gate.resolve("Allow once"); // 迟到批准
		await vi.advanceTimersByTimeAsync(0);
		const late = deferred<string | undefined>();
		const second = deafChannel(late.promise);
		const pending2 = runApprovalDialog(second.channel, "T", ["Deny", "Allow once"], undefined, { timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending2).resolves.toEqual({ choice: undefined });
		late.reject(new Error("late host error")); // 迟到 reject：必须已被订阅，不得成为 unhandled rejection
		await vi.advanceTimersByTimeAsync(0);
	});

	it("宿主 select 抛普通错误：按取消 fail-closed，不冒泡成工具错误", async () => {
		const select = vi.fn(async () => {
			throw new Error("ui exploded");
		});
		await expect(runApprovalDialog({ select }, "T", ["Deny", "Allow once"], undefined, { timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: undefined });
	});

	it("病态 external signal（aborted getter 抛错）：按取消 fail-closed，不 reject", async () => {
		const hostile = {
			get aborted(): boolean {
				throw new Error("hostile signal");
			},
			addEventListener() {
				throw new Error("hostile signal");
			},
			removeEventListener() {
				throw new Error("hostile signal");
			},
		} as unknown as AbortSignal;
		const { channel, select } = deafChannel(new Promise<string | undefined>(() => {}));
		await expect(runApprovalDialog(channel, "T", ["Deny", "Allow once"], undefined, { signal: hostile, timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: undefined });
		expect(select).not.toHaveBeenCalled();
	});
});

describe("runApprovalDialog：两步式（select → Deny 后可选 input）", () => {
	function twoStepHost(choice: string | undefined, inputImpl?: () => Promise<string | undefined>) {
		const select = vi.fn(async () => choice);
		const input = vi.fn(inputImpl ?? (async () => "because"));
		const channel: ApprovalDialogChannel = { select, input };
		return { channel, select, input };
	}

	it("Deny → 追问理由并原样返回", async () => {
		const { channel, input } = twoStepHost("Deny");
		await expect(runApprovalDialog(channel, "T", ["Deny", "Allow once"], reasonPrompt, { timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: "Deny", reason: "because" });
		expect(input).toHaveBeenCalledWith("Why deny?", "optional", expect.objectContaining({ timeout: 300_000 }));
	});
	it("Allow once → 不追问理由", async () => {
		const { channel, input } = twoStepHost("Allow once");
		await expect(runApprovalDialog(channel, "T", ["Deny", "Allow once"], reasonPrompt, { timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: "Allow once" });
		expect(input).not.toHaveBeenCalled();
	});
	it("无 input 通道 → Deny 无理由", async () => {
		const select = vi.fn(async () => "Deny");
		await expect(runApprovalDialog({ select }, "T", ["Deny", "Allow once"], reasonPrompt, { timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: "Deny" });
	});
	it("理由步宿主正常返回 undefined / 抛普通异常 → 保持 Deny 无理由", async () => {
		const empty = twoStepHost("Deny", async () => undefined);
		await expect(runApprovalDialog(empty.channel, "T", ["Deny", "Allow once"], reasonPrompt, { timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: "Deny" });
		const broken = twoStepHost("Deny", async () => {
			throw new Error("ui exploded");
		});
		await expect(runApprovalDialog(broken.channel, "T", ["Deny", "Allow once"], reasonPrompt, { timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: "Deny" });
	});
	it("理由步本地超时 → 整次审批取消（不是 Deny 无理由）", async () => {
		vi.useFakeTimers();
		const select = vi.fn(async () => "Deny");
		const input = vi.fn(() => new Promise<string | undefined>(() => {}));
		const pending = runApprovalDialog({ select, input }, "T", ["Deny", "Allow once"], reasonPrompt, { timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).resolves.toEqual({ choice: undefined });
	});
	it("理由步外部 abort → 整次审批取消", async () => {
		const ac = new AbortController();
		const select = vi.fn(async () => "Deny");
		const input = vi.fn(() => new Promise<string | undefined>(() => {}));
		const pending = runApprovalDialog({ select, input }, "T", ["Deny", "Allow once"], reasonPrompt, { signal: ac.signal, timeoutMs: 300_000 });
		await vi.waitFor(() => expect(input).toHaveBeenCalled());
		ac.abort();
		await expect(pending).resolves.toEqual({ choice: undefined });
	});
});

describe("runApprovalDialog：清理与并发", () => {
	it("正常应答后清掉本地 timer 与外部 signal listener", async () => {
		vi.useFakeTimers();
		const ac = new AbortController();
		const removeListener = vi.spyOn(ac.signal, "removeEventListener");
		const select = vi.fn(async () => "Allow once");
		await runApprovalDialog({ select }, "T", ["Deny", "Allow once"], undefined, { signal: ac.signal, timeoutMs: 300_000 });
		expect(vi.getTimerCount()).toBe(0);
		expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
	});
	it("两个审批会话互不影响：取消 A 不取消 B", async () => {
		const acA = new AbortController();
		const gateB = deferred<string | undefined>();
		const selectA = vi.fn(() => new Promise<string | undefined>(() => {}));
		const selectB = vi.fn(() => gateB.promise);
		const a = runApprovalDialog({ select: selectA }, "A", ["Deny", "Allow once"], undefined, { signal: acA.signal, timeoutMs: 300_000 });
		const b = runApprovalDialog({ select: selectB }, "B", ["Deny", "Allow once"], undefined, { timeoutMs: 300_000 });
		acA.abort();
		await expect(a).resolves.toEqual({ choice: undefined });
		gateB.resolve("Allow once");
		await expect(b).resolves.toEqual({ choice: "Allow once" });
	});
});
