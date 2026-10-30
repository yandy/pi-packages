import { describe, it } from "vitest";
import { createSandboxTools, type SandboxToolDeps } from "../src/tools";
import { assertPromptHygiene } from "../../scripts/prompt-hygiene";

function deps(): SandboxToolDeps {
	return {
		cwd: "/tmp",
		permission: { override: undefined } as never,
		platform: "linux",
	};
}

describe("prompt hygiene", () => {
	it("bash/write/edit 的三通道文案符合约定且不超预算（含继承的内置 snippet/guideline）", () => {
		const { bash, write, edit } = createSandboxTools(deps());
		assertPromptHygiene({
			pkg: "pi-sandbox",
			budget: 4800,
			tools: [bash, write, edit],
			// 内置 snippet/guideline 是 pi 写的，不参与本仓措辞检查；两条沙箱规则仍按长度闸。
			authored: [],
		});
	});
});
