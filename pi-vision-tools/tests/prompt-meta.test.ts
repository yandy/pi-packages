import { describe, it } from "vitest";
import { assertPromptHygiene } from "../../scripts/prompt-hygiene";
import extension from "../index";

function captureTools(): any[] {
	const tools: any[] = [];
	const noop = () => {};
	const pi = {
		registerTool: (def: any) => tools.push(def),
		registerCommand: noop,
		registerFlag: noop,
		on: noop,
		getActiveTools: () => [],
		setActiveTools: noop,
		events: { emit: noop },
	};
	extension(pi as never);
	return tools;
}

describe("prompt hygiene", () => {
	it("describe_image 的三通道文案符合约定且不超预算", () => {
		assertPromptHygiene({
			pkg: "pi-vision-tools",
			budget: 1150,
			tools: captureTools(),
			authored: ["describe_image"],
		});
	});
});
