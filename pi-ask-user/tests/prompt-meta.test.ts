import { describe, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertPromptHygiene } from "../../scripts/prompt-hygiene";
import register from "../index";

function captureTools(): any[] {
	const tools: any[] = [];
	const noop = () => {};
	const stub = {
		registerTool: (def: any) => tools.push(def),
		registerCommand: noop,
		registerFlag: noop,
		on: noop,
		getFlag: () => undefined,
		getActiveTools: () => [],
		setActiveTools: noop,
		events: { emit: noop },
	};
	register(stub as unknown as ExtensionAPI);
	return tools;
}

describe("prompt hygiene", () => {
	it("ask_user 的三通道文案符合约定且不超预算", () => {
		assertPromptHygiene({
			pkg: "pi-ask-user",
			budget: 1650,
			tools: captureTools(),
			authored: ["ask_user"],
		});
	});
});
