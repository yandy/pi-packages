import { describe, expect, it } from "vitest";
import { DICT, t } from "../src/i18n";

describe("i18n", () => {
	it("keeps the en and zh key sets identical", () => {
		expect(Object.keys(DICT.zh).sort()).toEqual(Object.keys(DICT.en).sort());
	});
	it("interpolates params", () => {
		expect(t("zh", { key: "hint.reserveHeadroom", params: { p: 87 } })).toContain("87");
		expect(t("en", { key: "hint.reserveHeadroom", params: { p: 87 } })).toContain("87");
	});
	it("falls back to the key itself", () => {
		expect(t("en", { key: "missing.key" })).toBe("missing.key");
	});
});
