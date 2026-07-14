import { describe, it, expect } from "vitest";
import { MEMORY_AGENT_TOOLS } from "../src/agent-config";

describe("MEMORY_AGENT_TOOLS", () => {
	it("contains read/write/edit/ls only", () => {
		expect([...MEMORY_AGENT_TOOLS]).toEqual(["read", "write", "edit", "ls"]);
		expect(MEMORY_AGENT_TOOLS).not.toContain("bash");
		expect(MEMORY_AGENT_TOOLS).not.toContain("websearch");
	});
});
