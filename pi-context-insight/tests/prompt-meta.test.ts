import { describe, it } from "vitest";
import { assertPromptHygiene } from "../../scripts/prompt-hygiene";

describe("prompt hygiene", () => {
	it("does not add tool prompt channels", () => {
		assertPromptHygiene({ pkg: "pi-context-insight", budget: 0, tools: [], authored: [] });
	});
});
