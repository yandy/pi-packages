import { describe, expect, it } from "vitest";

import { pickMostRestrictive } from "../../../src/handlers/gates/candidate-check";

import { makeGateCheckResult } from "../../helpers/gate-fixtures";

describe("pickMostRestrictive", () => {
	it("returns undefined for an empty list", () => {
		expect(pickMostRestrictive([])).toBeUndefined();
	});

	it("returns the single result for a one-element list", () => {
		const only = makeGateCheckResult({ state: "allow" });
		expect(pickMostRestrictive([only])).toBe(only);
	});

	it("prefers deny over ask and allow regardless of position", () => {
		const allow = makeGateCheckResult({ state: "allow", matchedPattern: "a" });
		const ask = makeGateCheckResult({ state: "ask", matchedPattern: "b" });
		const deny = makeGateCheckResult({ state: "deny", matchedPattern: "c" });
		expect(pickMostRestrictive([allow, ask, deny])).toBe(deny);
		expect(pickMostRestrictive([deny, ask, allow])).toBe(deny);
	});

	it("prefers ask over allow when no deny is present", () => {
		const allow = makeGateCheckResult({ state: "allow" });
		const ask = makeGateCheckResult({ state: "ask" });
		expect(pickMostRestrictive([allow, ask])).toBe(ask);
	});

	it("keeps the first deny on ties", () => {
		const deny1 = makeGateCheckResult({
			state: "deny",
			matchedPattern: "first",
		});
		const deny2 = makeGateCheckResult({
			state: "deny",
			matchedPattern: "second",
		});
		expect(pickMostRestrictive([deny1, deny2])).toBe(deny1);
	});

	it("keeps the first ask on ties when no deny is present", () => {
		const allow = makeGateCheckResult({ state: "allow" });
		const ask1 = makeGateCheckResult({ state: "ask", matchedPattern: "first" });
		const ask2 = makeGateCheckResult({
			state: "ask",
			matchedPattern: "second",
		});
		expect(pickMostRestrictive([allow, ask1, ask2])).toBe(ask1);
	});
});
