import { describe, expect, it } from "vitest";
import { assertPromptHygiene } from "../../scripts/prompt-hygiene";
import extension from "../index";

function captureTools(): any[] {
	const tools: any[] = [];
	extension({ registerTool: (def: any) => tools.push(def) } as never);
	return tools;
}

describe("prompt hygiene", () => {
	it("websearch/webfetch 的三通道文案符合约定且不超预算", () => {
		assertPromptHygiene({
			pkg: "pi-web-tools",
			budget: 2150,
			tools: captureTools(),
			authored: ["websearch", "webfetch"],
		});
	});
});
