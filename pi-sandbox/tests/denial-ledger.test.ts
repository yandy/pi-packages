import { afterEach, describe, expect, it } from "vitest";
import { getDenialLedger, resetDenialLedgerForTests } from "../src/denial-ledger";

afterEach(() => {
	// 模块级全局槽位跨测试复位（testing.md：模块单例必须显式复位）
	resetDenialLedgerForTests();
});

describe("getDenialLedger", () => {
	it("globalThis 单例：重复调用同一对象，reset 后换新对象", () => {
		const first = getDenialLedger();
		expect(getDenialLedger()).toBe(first);
		resetDenialLedgerForTests();
		expect(getDenialLedger()).not.toBe(first);
	});
});

describe("record/consume（一次性、按会话与 kind 隔离）", () => {
	it("未记录 → consume false", () => {
		expect(getDenialLedger().consume("s1", "command")).toBe(false);
	});
	it("记录后 consume true，且一次性（第二次 false）", () => {
		const ledger = getDenialLedger();
		ledger.record("s1", "command");
		expect(ledger.consume("s1", "command")).toBe(true);
		expect(ledger.consume("s1", "command")).toBe(false);
	});
	it("kind 隔离：command 记录不放行 operation 提权（反之亦然）", () => {
		const ledger = getDenialLedger();
		ledger.record("s1", "command");
		expect(ledger.consume("s1", "operation")).toBe(false);
		expect(ledger.consume("s1", "command")).toBe(true);
	});
	it("两个 kind 各自独立消费", () => {
		const ledger = getDenialLedger();
		ledger.record("s1", "command");
		ledger.record("s1", "operation");
		expect(ledger.consume("s1", "operation")).toBe(true);
		expect(ledger.consume("s1", "command")).toBe(true);
	});
	it("会话隔离：别的会话的记录不放行本会话（父子各记各的）", () => {
		const ledger = getDenialLedger();
		ledger.record("s1", "command");
		expect(ledger.consume("s2", "command")).toBe(false);
		expect(ledger.consume("s1", "command")).toBe(true);
	});
	it("重复 record 幂等（只消费一次）", () => {
		const ledger = getDenialLedger();
		ledger.record("s1", "command");
		ledger.record("s1", "command");
		expect(ledger.consume("s1", "command")).toBe(true);
		expect(ledger.consume("s1", "command")).toBe(false);
	});
	it("空 sessionId 不记账（防御，不产生孤儿条目）", () => {
		const ledger = getDenialLedger();
		ledger.record("", "command");
		expect(ledger.consume("", "command")).toBe(false);
	});
	it("forget 清掉会话的全部未消费记录", () => {
		const ledger = getDenialLedger();
		ledger.record("s1", "command");
		ledger.record("s1", "operation");
		ledger.forget("s1");
		expect(ledger.consume("s1", "command")).toBe(false);
		expect(ledger.consume("s1", "operation")).toBe(false);
	});
	it("forget 只影响目标会话", () => {
		const ledger = getDenialLedger();
		ledger.record("s1", "command");
		ledger.record("s2", "command");
		ledger.forget("s1");
		expect(ledger.consume("s2", "command")).toBe(true);
	});
});
