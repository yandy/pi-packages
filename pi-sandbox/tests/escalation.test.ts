import { describe, expect, it, vi } from "vitest";
import { approveEscalation, escalationAppliedMarker, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs, WIDER_MODES } from "../src/escalation";

const base = {
	justification: "need to install a global npm package",
	effectiveMode: "workspace-write" as const,
	subject: "command" as const,
	summary: "npm i -g foo",
};

function ui(hasUI: boolean, choice: string | undefined) {
	return { hasUI, select: vi.fn(async () => choice) };
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
	it("both absent: ok (a plain call)", () => {
		expect(() => validateEscalationArgs(undefined, undefined)).not.toThrow();
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
});

describe("WIDER_MODES", () => {
	it("read-only widens to both; workspace-write only to full access; nothing widens to read-only", () => {
		expect(WIDER_MODES["read-only"]).toEqual(["workspace-write", "danger-full-access"]);
		expect(WIDER_MODES["workspace-write"]).toEqual(["danger-full-access"]);
		expect(WIDER_MODES["danger-full-access"]).toBeUndefined();
	});
});

describe("approveEscalation", () => {
	it("same mode as effective: no approval needed", async () => {
		const u = ui(true, "Deny");
		await expect(approveEscalation({ ...base, requestedMode: "workspace-write" }, u)).resolves.toBe("workspace-write");
		expect(u.select).not.toHaveBeenCalled();
	});
	it("strictly wider + Allow once → granted mode (one-shot)", async () => {
		const u = ui(true, "Allow once");
		await expect(approveEscalation({ ...base, requestedMode: "danger-full-access" }, u)).resolves.toBe("danger-full-access");
		const title = u.select.mock.calls[0][0] as string;
		expect(title).toContain("danger-full-access");
		expect(title).toContain(base.justification);
		expect(title).toContain(base.summary);
		expect(u.select.mock.calls[0][1]).toEqual(["Allow once", "Deny"]);
	});
	it("Deny → rejected error telling the model to stop", async () => {
		await expect(approveEscalation({ ...base, requestedMode: "danger-full-access" }, ui(true, "Deny")))
			.rejects.toThrow(/rejected escalating this command to "danger-full-access".*stop and explain instead of working around it/s);
	});
	it("select returned undefined → cancelled error", async () => {
		await expect(approveEscalation({ ...base, requestedMode: "danger-full-access" }, ui(true, undefined)))
			.rejects.toThrow(/cancelled/);
	});
	it("narrower target → not-strictly-wider error, no prompt", async () => {
		const u = ui(true, "Allow once");
		await expect(approveEscalation({ ...base, effectiveMode: "danger-full-access", requestedMode: "workspace-write" }, u))
			.rejects.toThrow(/not strictly wider.*nothing was executed/s);
		expect(u.select).not.toHaveBeenCalled();
	});
	it("hasUI=false → unavailable error BEFORE any select (Review Focus #4), with the /permission rescue path", async () => {
		const u = ui(false, "Allow once");
		await expect(approveEscalation({ ...base, requestedMode: "danger-full-access" }, u))
			.rejects.toThrow(/no approval channel is available.*nothing was executed.*\/permission danger-full-access/s);
		expect(u.select).not.toHaveBeenCalled();
	});
});
