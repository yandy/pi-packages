import { describe, expect, it, vi } from "vitest";
import { assertPromptHygiene } from "../../scripts/prompt-hygiene";
import extension from "../index.js";

/** 提示词卫生闸门（spec 2026-10-30 §8 W4）。预算与规则见 scripts/prompt-hygiene.ts。 */
function captureTools(): any[] {
	const tools: any[] = [];
	const pi = {
		registerTool: (def: any) => tools.push(def),
		registerCommand: () => {},
		on: () => () => {},
	};
	const ctx = { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget: vi.fn(), theme: {} } };
	extension(pi as any);
	void ctx;
	return tools;
}

describe("prompt hygiene", () => {
	it("todo 的三通道文案符合约定且不超预算", () => {
		assertPromptHygiene({
			pkg: "pi-todo",
			budget: 1800,
			tools: captureTools(),
			authored: ["todo"],
		});
	});

	it("行为规则不进 description（只留 API 契约）", () => {
		const [tool] = captureTools();
		for (const guideline of tool.promptGuidelines) {
			expect(tool.description.includes(guideline.trim())).toBe(false);
		}
	});
});
