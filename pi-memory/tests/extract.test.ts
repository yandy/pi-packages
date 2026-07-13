import { describe, it, expect } from "vitest";
import { buildExtractTask } from "../src/extract";

describe("buildExtractTask", () => {
	it("builds extraction task prompt with context", () => {
		const messages = [
			{ role: "user", content: "how to debug SSH?" },
			{ role: "assistant", content: "Use ssh -vvv user@host" },
		];
		const task = buildExtractTask("/tmp/mem", messages, 2000);
		expect(task).toContain("memory extraction agent");
		expect(task).toContain("/tmp/mem");
		expect(task).toContain("how to debug SSH?");
		expect(task).toContain("ssh -vvv");
		expect(task).toContain("Worth remembering");
		expect(task).toContain("NOT worth remembering");
		expect(task).toContain("frontmatter");
		expect(task).toContain("## Entry Title");
	});

	it("truncates long messages", () => {
		const longMsg = "x".repeat(5000);
		const task = buildExtractTask("/tmp/mem", [{ role: "user", content: longMsg }], 100);
		expect(task.length).toBeLessThan(5000);
	});
});
