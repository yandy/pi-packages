import { describe, it, expect } from "vitest";
import { FILE_IO_TOOLS } from "../src/agent-config";

describe("FILE_IO_TOOLS", () => {
	it("contains read/write/edit/ls only", () => {
		expect([...FILE_IO_TOOLS]).toEqual(["read", "write", "edit", "ls"]);
		expect(FILE_IO_TOOLS).not.toContain("bash");
		expect(FILE_IO_TOOLS).not.toContain("websearch");
	});
});
