import { afterEach, describe, expect, it, vi } from "vitest";
import {
	APPROVAL_DIALOG_DEFAULT_TIMEOUT_MS,
	type ApprovalDialogChannel,
	type ApprovalDialogOptions,
	dialogTimeoutMs,
	runApprovalDialog,
} from "../src/approval-dialog";
import type { DenialReasonPrompt } from "../src/escalation";

/** 一个可由测试手动结算的宿主应答（判“迟到结果”“未应答”用）。 */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * 完全忽略 opts 的敌对宿主：既不听 signal，也不自己计时。
 * 这是契约里最坏的情况——结算只能靠本包的本地 guard。
 */
function deafChannel(outcome: Promise<string | undefined>) {
	const select = vi.fn(() => outcome);
	const channel: ApprovalDialogChannel = { select };
	return { channel, select };
}

const never = () => new Promise<string | undefined>(() => {});

const reasonPrompt: DenialReasonPrompt = { title: "Why deny?", placeholder: "optional" };

const OPTIONS = ["Deny", "Allow once"];

afterEach(() => {
	vi.useRealTimers();
});

describe("dialogTimeoutMs：非 TUI 有默认 deadline，TUI 无上限", () => {
	it("RPC / json / print 都用 300_000ms 默认值", () => {
		expect(APPROVAL_DIALOG_DEFAULT_TIMEOUT_MS).toBe(300_000);
		expect(dialogTimeoutMs("rpc")).toBe(APPROVAL_DIALOG_DEFAULT_TIMEOUT_MS);
		expect(dialogTimeoutMs("json")).toBe(APPROVAL_DIALOG_DEFAULT_TIMEOUT_MS);
		expect(dialogTimeoutMs("print")).toBe(APPROVAL_DIALOG_DEFAULT_TIMEOUT_MS);
	});

	it("模式读不出来时按非 TUI 兜底（挂死比误取消更糟）", () => {
		expect(dialogTimeoutMs(undefined)).toBe(APPROVAL_DIALOG_DEFAULT_TIMEOUT_MS);
		expect(dialogTimeoutMs("unexpected-mode")).toBe(APPROVAL_DIALOG_DEFAULT_TIMEOUT_MS);
	});

	it("TUI 不设默认上限（用户有 Esc / Ctrl-C）", () => {
		expect(dialogTimeoutMs("tui")).toBeUndefined();
	});
});

describe("runApprovalDialog：向宿主传派生 signal 与 timeout", () => {
	it("调用方没有 signal 时仍传派生 signal + timeout", async () => {
		const select = vi.fn(async () => "Allow once");
		await runApprovalDialog({ select }, "T", OPTIONS, undefined, { timeoutMs: 300_000 });
		const opts = select.mock.calls[0][2] as ApprovalDialogOptions;
		expect(opts.timeout).toBe(300_000);
		expect(opts.signal).toBeInstanceOf(AbortSignal);
	});

	it("TUI（无 deadline）：不传 timeout，但仍传派生 signal 以便关闭在飞弹窗", async () => {
		const select = vi.fn(async () => "Allow once");
		await runApprovalDialog({ select }, "T", OPTIONS, undefined, { timeoutMs: undefined });
		const opts = select.mock.calls[0][2] as ApprovalDialogOptions;
		expect(opts.timeout).toBeUndefined();
		expect(opts.signal).toBeInstanceOf(AbortSignal);
	});

	it("外部 abort 传播到派生 signal（宿主能看到并关闭弹窗）", async () => {
		const ac = new AbortController();
		let derived: AbortSignal | undefined;
		const select = vi.fn((_title: string, _options: string[], opts?: ApprovalDialogOptions) => {
			derived = opts?.signal;
			return never();
		});
		const pending = runApprovalDialog({ select }, "T", OPTIONS, undefined, { signal: ac.signal, timeoutMs: 300_000 });
		await vi.waitFor(() => expect(derived).toBeDefined());
		ac.abort();
		await expect(pending).resolves.toEqual({ choice: undefined });
		expect(derived?.aborted).toBe(true);
	});
});

describe("runApprovalDialog：本地 deadline 与 abort 结算", () => {
	it("宿主永不应答：N-1ms 仍挂起，Nms 结算为取消", async () => {
		vi.useFakeTimers();
		const { channel } = deafChannel(never());
		const pending = runApprovalDialog(channel, "T", OPTIONS, undefined, { timeoutMs: 1_000 });
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toEqual({ choice: undefined });
	});

	it("调用前已 abort：根本不打开弹窗", async () => {
		const ac = new AbortController();
		ac.abort();
		const { channel, select } = deafChannel(never());
		await expect(runApprovalDialog(channel, "T", OPTIONS, undefined, { signal: ac.signal, timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: undefined });
		expect(select).not.toHaveBeenCalled();
	});

	it("在飞 abort + 宿主忽略 opts：仍能本地结算为取消", async () => {
		const ac = new AbortController();
		const { channel } = deafChannel(never());
		const pending = runApprovalDialog(channel, "T", OPTIONS, undefined, { signal: ac.signal, timeoutMs: 300_000 });
		ac.abort();
		await expect(pending).resolves.toEqual({ choice: undefined });
	});

	it("同步 reject 竞态：宿主在 abort listener 里同步 reject，结果仍是取消而非宿主错误", async () => {
		const ac = new AbortController();
		const select = vi.fn((_title: string, _options: string[], opts?: ApprovalDialogOptions) =>
			new Promise<string | undefined>((_resolve, reject) => {
				opts?.signal?.addEventListener("abort", () => reject(new Error("host rejected on abort")));
			}));
		const pending = runApprovalDialog({ select }, "T", OPTIONS, undefined, { signal: ac.signal, timeoutMs: 300_000 });
		ac.abort();
		await expect(pending).resolves.toEqual({ choice: undefined });
	});

	it("deadline 触发的同步 reject 同样是取消（本地取消拥有最终裁决权）", async () => {
		vi.useFakeTimers();
		const select = vi.fn((_title: string, _options: string[], opts?: ApprovalDialogOptions) =>
			new Promise<string | undefined>((_resolve, reject) => {
				opts?.signal?.addEventListener("abort", () => reject(new Error("host rejected on timeout")));
			}));
		const pending = runApprovalDialog({ select }, "T", OPTIONS, undefined, { timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).resolves.toEqual({ choice: undefined });
	});

	it("迟到结果：超时后迟到的 Allow once 不被采纳，迟到 reject 不成为 unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const late = deferred<string | undefined>();
			const { channel } = deafChannel(late.promise);
			await expect(runApprovalDialog(channel, "T", OPTIONS, undefined, { timeoutMs: 20 }))
				.resolves.toEqual({ choice: undefined });
			late.resolve("Allow once"); // 到期后的批准不得执行任何东西
			await new Promise((resolve) => setTimeout(resolve, 0));

			const lateError = deferred<string | undefined>();
			await expect(runApprovalDialog(deafChannel(lateError.promise).channel, "T", OPTIONS, undefined, { timeoutMs: 20 }))
				.resolves.toEqual({ choice: undefined });
			lateError.reject(new Error("late host failure"));
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("宿主 select 抛普通错误：按取消 fail-closed，不冒泡成工具错误", async () => {
		const select = vi.fn(async () => {
			throw new Error("ui exploded");
		});
		await expect(runApprovalDialog({ select }, "T", OPTIONS, undefined, { timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: undefined });
	});

	it("病态 external signal（读 / 监听都抛错）：按取消 fail-closed，不 reject", async () => {
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
		const { channel, select } = deafChannel(never());
		await expect(runApprovalDialog(channel, "T", OPTIONS, undefined, { signal: hostile, timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: undefined });
		expect(select).not.toHaveBeenCalled();
	});
});

describe("runApprovalDialog：两步式（select → Deny 后可选 input）", () => {
	function twoStep(choice: string | undefined, inputImpl: () => Promise<string | undefined> = async () => "because") {
		const select = vi.fn(async () => choice);
		const input = vi.fn(inputImpl);
		return { channel: { select, input } as ApprovalDialogChannel, select, input };
	}

	it("Deny → 追问理由并原样返回", async () => {
		const { channel, input } = twoStep("Deny");
		await expect(runApprovalDialog(channel, "T", OPTIONS, reasonPrompt, { timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: "Deny", reason: "because" });
		expect(input).toHaveBeenCalledWith("Why deny?", "optional", expect.objectContaining({ timeout: 300_000, signal: expect.any(AbortSignal) }));
	});

	it("Allow once → 不追问理由", async () => {
		const { channel, input } = twoStep("Allow once");
		await expect(runApprovalDialog(channel, "T", OPTIONS, reasonPrompt, { timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: "Allow once" });
		expect(input).not.toHaveBeenCalled();
	});

	it("通道没有 input：Deny 照常结算，无理由", async () => {
		const select = vi.fn(async () => "Deny");
		await expect(runApprovalDialog({ select }, "T", OPTIONS, reasonPrompt, { timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: "Deny" });
	});

	it("理由步宿主返回空值或抛普通异常：保持 Deny、无理由（只有本地取消才整次取消）", async () => {
		const empty = twoStep("Deny", async () => undefined);
		await expect(runApprovalDialog(empty.channel, "T", OPTIONS, reasonPrompt, { timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: "Deny" });
		const broken = twoStep("Deny", async () => {
			throw new Error("ui exploded");
		});
		await expect(runApprovalDialog(broken.channel, "T", OPTIONS, reasonPrompt, { timeoutMs: 300_000 }))
			.resolves.toEqual({ choice: "Deny" });
	});

	it("理由步本地 deadline 到期 → 整次审批取消（不能吞成 Deny、无理由）", async () => {
		vi.useFakeTimers();
		const select = vi.fn(async () => "Deny");
		const input = vi.fn(never);
		const pending = runApprovalDialog({ select, input }, "T", OPTIONS, reasonPrompt, { timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).resolves.toEqual({ choice: undefined });
	});

	it("理由步外部 abort → 整次审批取消", async () => {
		const ac = new AbortController();
		const select = vi.fn(async () => "Deny");
		const input = vi.fn(never);
		const pending = runApprovalDialog({ select, input }, "T", OPTIONS, reasonPrompt, { signal: ac.signal, timeoutMs: 300_000 });
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
		await runApprovalDialog({ select }, "T", OPTIONS, undefined, { signal: ac.signal, timeoutMs: 300_000 });
		expect(vi.getTimerCount()).toBe(0);
		expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("两次审批各自持有独立 session：取消 A 不影响 B", async () => {
		const acA = new AbortController();
		const gateB = deferred<string | undefined>();
		const a = runApprovalDialog({ select: vi.fn(never) }, "A", OPTIONS, undefined, { signal: acA.signal, timeoutMs: 300_000 });
		const b = runApprovalDialog({ select: vi.fn(() => gateB.promise) }, "B", OPTIONS, undefined, { timeoutMs: 300_000 });
		acA.abort();
		await expect(a).resolves.toEqual({ choice: undefined });
		gateB.resolve("Allow once");
		await expect(b).resolves.toEqual({ choice: "Allow once" });
	});
});
