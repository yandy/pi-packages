/**
 * denial-ledger.ts — denial-first 提权门禁的会话级拒绝账本。
 *
 * 语义：bash/write/edit 被沙箱真正拒绝时记一笔；模型对同一会话、同一工具类
 * （command ↔ bash，operation ↔ write/edit）的下一次提权请求消费这笔记录。
 * 没有未消费记录时的提权参数被 resolveCall 忽略——这是"未经拒绝不提权"的硬约束，
 * 消除模型先发制人带提权参数导致的审批轰炸（2026-10-02 决策）。
 *
 * 跨 jiti 实例：父子会话是各自独立的模块实例，globalThis 是唯一共享点
 * （与 permission.ts / escalation-broker.ts 同构）；按 sessionId 隔离，子会话各记各的。
 */

/** 记录的种类：与 resolveCall 的 subject 一一对应。 */
export type DenialKind = "command" | "operation";

export interface DenialLedger {
	/** 记一笔待消费的拒绝（同一 kind 重复记幂等）。 */
	record(sessionId: string, kind: DenialKind): void;
	/** 消费一笔记录；没有则返回 false。一次性：消费即清除。 */
	consume(sessionId: string, kind: DenialKind): boolean;
	/** 会话销毁时清理（session_shutdown / child disposed），防长进程 Map 泄漏。 */
	forget(sessionId: string): void;
}

/** 进程全局槽位键：带包名前缀，避免与其他扩展的 globalThis 使用相撞。 */
const LEDGER_KEY = Symbol.for("@yandy0725/pi-sandbox:denial-ledger");

class InProcessDenialLedger implements DenialLedger {
	private readonly pending = new Map<string, Set<DenialKind>>();

	record(sessionId: string, kind: DenialKind): void {
		if (!sessionId) return;
		let kinds = this.pending.get(sessionId);
		if (kinds === undefined) {
			kinds = new Set();
			this.pending.set(sessionId, kinds);
		}
		kinds.add(kind);
	}

	consume(sessionId: string, kind: DenialKind): boolean {
		const kinds = this.pending.get(sessionId);
		if (kinds === undefined || !kinds.has(kind)) return false;
		kinds.delete(kind);
		if (kinds.size === 0) this.pending.delete(sessionId);
		return true;
	}

	forget(sessionId: string): void {
		this.pending.delete(sessionId);
	}
}

/** 进程全局单例：父子会话各自的 jiti 实例共享同一对象（与 getEscalationBroker 同构）。 */
export function getDenialLedger(): DenialLedger {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[LEDGER_KEY] as DenialLedger | undefined;
	if (existing !== undefined) return existing;
	const ledger = new InProcessDenialLedger();
	store[LEDGER_KEY] = ledger;
	return ledger;
}

/** 仅供测试复位全局槽位（生产代码不得调用）。 */
export function resetDenialLedgerForTests(): void {
	delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
}
