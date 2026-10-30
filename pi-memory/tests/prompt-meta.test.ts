import { describe, it } from "vitest";
import { assertPromptHygiene } from "../../scripts/prompt-hygiene";
import { createMemoryTool, type MemoryToolDeps } from "../src/memory-tool";

const deps: MemoryToolDeps = {
	getMemoryDir: () => "/nonexistent",
	getStore: () => null,
	getConfig: () => ({
		memIndexMaxLines: 200,
		memIndexMaxBytes: 25600,
		sessionSearch: { maxSessions: 10, maxMatches: 5 },
	}),
	getUnavailableMessage: () => "unavailable",
	searchSessions: async () => "",
	cwd: () => "/tmp",
};

describe("prompt hygiene", () => {
	it("memory 的三通道文案符合约定且不超预算", () => {
		assertPromptHygiene({
			pkg: "pi-memory",
			budget: 2750,
			tools: [createMemoryTool(deps)],
			authored: ["memory"],
		});
	});
});
