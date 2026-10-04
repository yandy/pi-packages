import { describe, expect, it, vi } from "vitest";
import {
	approveEscalation,
	DENIAL_REASON_PROMPT,
	escalationAppliedMarker,
	escalationHintMarker,
	escalationIgnoredMarker,
	isStrictlyWider,
	normalizeEscalationValue,
	sandboxDenialMarker,
	sanitizeDenialReason,
	stripEscalationPlaceholders,
	validateEscalationArgs,
	WIDER_MODES,
} from "../src/escalation";

const base = {
	justification: "need to install a global npm package",
	effectiveMode: "workspace-write" as const,
	subject: "command" as const,
	summary: "npm i -g foo",
};

/** 审批对话假件：ask 记录调用并返回固定结算（choice + 可选 Deny 理由）。 */
function ui(hasUI: boolean, choice: string | undefined, reason?: string) {
	const ask = vi.fn(async () => ({ choice, reason }));
	return { hasUI, ask };
}

describe("validateEscalationArgs", () => {
	it("both present and non-empty: ok", () => {
		expect(() => validateEscalationArgs("danger-full-access", "because")).not.toThrow();
	});
	it("permissions without justification: malformed + actionable (nothing ran, fix recipe)", () => {
		expect(() => validateEscalationArgs("danger-full-access", undefined))
			.toThrow(/nothing ran.*Cause: sandbox_permissions was sent without justification.*omit BOTH fields/s);
	});
	it("justification without permissions: malformed (the null-placeholder failure mode)", () => {
		expect(() => validateEscalationArgs(undefined, "because"))
			.toThrow(/nothing ran.*Cause: justification was sent without sandbox_permissions.*omit BOTH fields/s);
	});
	it("blank justification: malformed", () => {
		expect(() => validateEscalationArgs("danger-full-access", "   "))
			.toThrow(/nothing ran.*Cause: justification was empty/);
	});
	// 2026-10-02 二次修订：配方只给正向表述，不再列负向子句（删掉 `never the string "null" or ""`）。
	it("fix recipe 只给正向配方：省略或 JSON null（不含与 strict schema 矛盾的 “never null”）", () => {
		expect(() => validateEscalationArgs("danger-full-access", undefined))
			.toThrow(/omit BOTH fields or send JSON null for BOTH/);
		expect(() => validateEscalationArgs("danger-full-access", undefined)).not.toThrow(/never null/);
		expect(() => validateEscalationArgs("danger-full-access", undefined)).not.toThrow(/never the string/);
	});
	it("both absent: ok (a plain call)", () => {
		expect(() => validateEscalationArgs(undefined, undefined)).not.toThrow();
	});
});

describe('normalizeEscalationValue（占位符归一化，按字段可达性定生死）', () => {
	// pi ≥1.0.0 实测：execute 之前有 validateToolArguments（针对 declared schema）。
	// 2026-10-02 三次修订：工具侧 prepareArguments（stripEscalationPlaceholders）在校验前剥掉字符串占位符，
	// 真实工具链上 "null" / "" 到不了这里；本函数是 resolveCall 层的兑底，承重于未走钩子的调用路径
	//（子代理转发、未来新增的工具入口）。
	// - justification 的字符串臂是 Type.String()（字段本身为 string | null）："null" / "NULL" / "" 都是合法字符串
	//   → 钩子一旦缺席就会真的到达 execute，归一化是 load-bearing 的（否则普通调用会被误判 MALFORMED，
	//   或带着 Reason: null 弹审批）；
	// - sandbox_permissions 是两个字面量枚举：字符串形态若不剥就在校验期被拒（execute 不会跑），只有 JSON null
	//   （schema 已显式声明）和“省略”能到 —— 这两个分支同样由本函数处理。
	it("null / 非字符串（含 JSON null）→ 未提供", () => {
		expect(normalizeEscalationValue(null)).toBeUndefined();
		expect(normalizeEscalationValue(undefined)).toBeUndefined();
		expect(normalizeEscalationValue(42)).toBeUndefined();
		expect(normalizeEscalationValue({})).toBeUndefined();
	});
	it('字符串 "null"（大小写与包裹空白）→ 未提供', () => {
		expect(normalizeEscalationValue("null")).toBeUndefined();
		expect(normalizeEscalationValue("NULL")).toBeUndefined();
		expect(normalizeEscalationValue("  Null  ")).toBeUndefined();
	});
	it("空串 / 纯空白 → 未提供", () => {
		expect(normalizeEscalationValue("")).toBeUndefined();
		expect(normalizeEscalationValue("   ")).toBeUndefined();
	});
	it("真实值 → trim 后原样返回", () => {
		expect(normalizeEscalationValue("danger-full-access")).toBe("danger-full-access");
		expect(normalizeEscalationValue("  workspace-write  ")).toBe("workspace-write");
	});
});

describe('stripEscalationPlaceholders（pi 校验前的占位符剥离，挂在工具 prepareArguments 上）', () => {
	it('两个占位符字符串都剥掉（主导场景：模型把可选字段填成 "null"）', () => {
		expect(stripEscalationPlaceholders({ command: "ls", sandbox_permissions: "null", justification: "null" }))
			.toEqual({ command: "ls" });
	});
	it("大小写无关 + 包裹空白 + 空串 / 纯空白都是占位符", () => {
		expect(stripEscalationPlaceholders({ sandbox_permissions: "NULL" })).toEqual({});
		expect(stripEscalationPlaceholders({ sandbox_permissions: "  Null  " })).toEqual({});
		expect(stripEscalationPlaceholders({ justification: "" })).toEqual({});
		expect(stripEscalationPlaceholders({ justification: "   " })).toEqual({});
	});
	it("JSON null 原样保留：Type.Null() 声明的合法取值仍走 resolveCall 的归一化，本钩子不改这条路径", () => {
		const args = { sandbox_permissions: null, justification: null };
		expect(stripEscalationPlaceholders(args)).toEqual({ sandbox_permissions: null, justification: null });
	});
	it("真提权原样保留（不误剥）；非法值原样保留（交给 pi 校验报错）", () => {
		const real = { sandbox_permissions: "danger-full-access", justification: "need /etc write" };
		expect(stripEscalationPlaceholders(real)).toBe(real);
		expect(stripEscalationPlaceholders({ sandbox_permissions: "read-only" })).toEqual({ sandbox_permissions: "read-only" });
		expect(stripEscalationPlaceholders({ justification: 42 })).toEqual({ justification: 42 });
	});
	it("非对象输入原样返回（防御模型输出 null / 数组 / 标量）", () => {
		expect(stripEscalationPlaceholders(null)).toBeNull();
		expect(stripEscalationPlaceholders([1, 2])).toEqual([1, 2]);
		expect(stripEscalationPlaceholders('"null"')).toBe('"null"');
		expect(stripEscalationPlaceholders(undefined)).toBeUndefined();
	});
	it("不 mutation 原对象：会话记录与 UI 里保留模型的原始输出", () => {
		const args = { command: "ls", sandbox_permissions: "null", justification: "null" };
		stripEscalationPlaceholders(args);
		expect(args).toEqual({ command: "ls", sandbox_permissions: "null", justification: "null" });
	});
	it("无占位符时返回同一引用：pi 的 prepareToolCallArguments 据此跳过替换（零扰动）", () => {
		const args = { command: "ls" };
		expect(stripEscalationPlaceholders(args)).toBe(args);
	});
});

describe("isStrictlyWider（denial-first 门禁与 approveEscalation 共用同一张表）", () => {
	it("read-only → 两档都更宽", () => {
		// 常量 pin（并入原 WIDER_MODES 表复述用例）：门禁与审批共用的这张表内容本身也钉死——
		// read-only 的更宽目标恰好两档，且 read-only 不在其列（「nothing widens to read-only」）。
		expect(WIDER_MODES["read-only"]).toEqual(["workspace-write", "danger-full-access"]);
		expect(isStrictlyWider("read-only", "workspace-write")).toBe(true);
		expect(isStrictlyWider("read-only", "danger-full-access")).toBe(true);
	});
	it("workspace-write → 仅 danger-full-access", () => {
		expect(isStrictlyWider("workspace-write", "danger-full-access")).toBe(true);
		expect(isStrictlyWider("workspace-write", "workspace-write")).toBe(false);
		expect(isStrictlyWider("workspace-write", "read-only")).toBe(false);
		expect(isStrictlyWider("workspace-write", "banana")).toBe(false);
	});
	it("danger-full-access → 没有更宽目标", () => {
		expect(isStrictlyWider("danger-full-access", "workspace-write")).toBe(false);
		expect(isStrictlyWider("danger-full-access", "danger-full-access")).toBe(false);
	});
});

describe("sanitizeDenialReason", () => {
	it("折叠空白并 trim（多行理由压成一行，不破坏错误文案格式）", () => {
		expect(sanitizeDenialReason("  don't   touch\n\n~/.aws ")).toBe("don't touch ~/.aws");
	});
	it("空 / 纯空白 / 非字符串 → undefined（拒绝文案逐字回退原样）", () => {
		expect(sanitizeDenialReason("")).toBeUndefined();
		expect(sanitizeDenialReason("   \n ")).toBeUndefined();
		expect(sanitizeDenialReason(undefined)).toBeUndefined();
	});
	it("截断到 500 字符 + 省略号（理由经错误进上下文，预算受控）", () => {
		const out = sanitizeDenialReason("x".repeat(600));
		expect(out?.length).toBe(501);
		expect(out?.endsWith("…")).toBe(true);
	});
});

describe("markers", () => {
	it("denial marker names the mode verbatim", () => {
		expect(sandboxDenialMarker("read-only")).toBe("[sandbox: file access denied under read-only mode]");
	});
	it("hint marker names the subject verbatim and offers the writable roots before escalation", () => {
		expect(escalationHintMarker("command")).toBe(
			"[sandbox: escalation available — writable here: the workspace + /tmp; retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]",
		);
	});
	it("applied marker says the approval covered this call only", () => {
		expect(escalationAppliedMarker("danger-full-access")).toBe(
			'[sandbox: this call ran with a one-shot escalation to "danger-full-access"; the approval covered this call only — later calls are confined again]',
		);
	});
	it("ignored marker names the mode and points at the denial-first contract", () => {
		expect(escalationIgnoredMarker("workspace-write")).toBe(
			'[sandbox: escalation fields were ignored — no sandbox denial was recorded for this session, so this call ran under "workspace-write" mode. Send escalation fields only when retrying a call that just returned a denial marker.]',
		);
	});
});

describe("approveEscalation", () => {
	it("same mode as effective: no approval needed", async () => {
		const u = ui(true, "Deny");
		await expect(approveEscalation({ ...base, requestedMode: "workspace-write" }, u)).resolves.toBe("workspace-write");
		expect(u.ask).not.toHaveBeenCalled();
	});
	it("strictly wider + Allow once → granted mode (one-shot)", async () => {
		const u = ui(true, "Allow once");
		await expect(approveEscalation({ ...base, requestedMode: "danger-full-access" }, u)).resolves.toBe("danger-full-access");
		const title = u.ask.mock.calls[0][0] as string;
		expect(title).toContain("danger-full-access");
		expect(title).toContain(base.justification);
		expect(title).toContain(base.summary);
		expect(u.ask.mock.calls[0][1]).toEqual(["Allow once", "Deny"]);
		// 两步式的第二步：Deny 理由追问提示随对话下发（ask 的第三参）。
		expect(u.ask.mock.calls[0][2]).toEqual(DENIAL_REASON_PROMPT);
	});
	it("Deny → rejected error telling the model to stop", async () => {
		await expect(approveEscalation({ ...base, requestedMode: "danger-full-access" }, ui(true, "Deny")))
			.rejects.toThrow(/rejected escalating this command to "danger-full-access".*stop and explain instead of working around it/s);
	});
	it("Deny + reason → 理由追加进错误文案（模型可见，知道为什么不行）", async () => {
		await expect(approveEscalation({ ...base, requestedMode: "danger-full-access" }, ui(true, "Deny", "never touch ~/.aws")))
			.rejects.toThrow(/stop and explain instead of working around it.*The user's reason: never touch ~\/\.aws/s);
	});
	it("Deny + 空白理由 → 不加后缀（拒绝文案逐字回退原样）", async () => {
		await expect(approveEscalation({ ...base, requestedMode: "danger-full-access" }, ui(true, "Deny", "   ")))
			.rejects.toThrow(/rewritten command$/s);
	});
	it("ask returned undefined → cancelled error", async () => {
		await expect(approveEscalation({ ...base, requestedMode: "danger-full-access" }, ui(true, undefined)))
			.rejects.toThrow(/cancelled/);
	});
	it("narrower target → not-strictly-wider error, no prompt", async () => {
		const u = ui(true, "Allow once");
		await expect(approveEscalation({ ...base, effectiveMode: "danger-full-access", requestedMode: "workspace-write" }, u))
			.rejects.toThrow(/not strictly wider.*nothing was executed/s);
		expect(u.ask).not.toHaveBeenCalled();
	});
	it("hasUI=false → unavailable error BEFORE any ask (Review Focus #4), with the /permission rescue path", async () => {
		const u = ui(false, "Allow once");
		await expect(approveEscalation({ ...base, requestedMode: "danger-full-access" }, u))
			.rejects.toThrow(/no approval channel is available.*nothing was executed.*\/permission danger-full-access/s);
		expect(u.ask).not.toHaveBeenCalled();
	});
});
