import { describe, expect, it } from "vitest";
import { parseNotifyRequest } from "../src/contract.js";

describe("parseNotifyRequest", () => {
	it("accepts a full request and trims its title", () => {
		expect(
			parseNotifyRequest({
				title: "  Approval required  ",
				body: "Dangerous?\nChoose carefully.",
				urgency: "critical",
			}),
		).toEqual({
			title: "Approval required",
			body: "Dangerous?\nChoose carefully.",
			urgency: "critical",
		});
	});

	it("accepts a minimal request without adding rendering defaults", () => {
		expect(parseNotifyRequest({ title: "Finished" })).toEqual({ title: "Finished" });
	});

	it("ignores unknown fields", () => {
		expect(parseNotifyRequest({ title: "Question", session: "must-not-leak", extra: 42 })).toEqual({
			title: "Question",
		});
	});

	it.each(["low", "normal", "critical"] as const)("accepts %s urgency", (urgency) => {
		expect(parseNotifyRequest({ title: "Notice", urgency })).toEqual({ title: "Notice", urgency });
	});

	it.each([
		["null", null],
		["undefined", undefined],
		["an array", [{ title: "Notice" }]],
		["a primitive", "notify"],
		["a missing title", { body: "Body" }],
		["a blank title", { title: " \n\t " }],
		["a non-string title", { title: 42 }],
		["a non-string body", { title: "Notice", body: 42 }],
		["an unsupported urgency", { title: "Notice", urgency: "urgent" }],
		["a non-string urgency", { title: "Notice", urgency: 1 }],
	])("rejects %s", (_name, payload) => {
		expect(parseNotifyRequest(payload)).toBeUndefined();
	});
});
