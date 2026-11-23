import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInsight } from "../src/command";
import { fakeContext } from "./helpers/ctx";
import { assistantEntry, resetEntryIds, systemEntry, toolCall, toolResultEntry, usage, userEntry } from "./helpers/entries";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("end to end report", () => {
	it("renders one self-contained file within the size budget", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-insight-budget-"));
		try {
			resetEntryIds();
			const entries = [systemEntry({ sections: { preamble: "base" }, timestamp: 0 })];
			let t = 1;
			for (let i = 0; i < 300; i++) {
				entries.push(userEntry(`question ${i}`, t++));
				entries.push(assistantEntry({ content: [toolCall(`c${i}`, "read", { path: `f${i}` })], usage: usage(1000, 50, 2000, 0, 0.01), timestamp: t++ }));
				entries.push(toolResultEntry({ toolCallId: `c${i}`, toolName: "read", content: `body ${i} `.repeat(200), timestamp: t++ }));
			}
			await runInsight("out.html", fakeContext({ entries }, { cwd: root }));
			const html = readFileSync(join(root, "out.html"), "utf8");
			expect(html).toContain("insight-payload");
			expect(html).toContain('data-card="browser"');
			expect(html).not.toContain("NaN");
			expect(Buffer.byteLength(html, "utf8")).toBeLessThan(16 * 1024 * 1024);
			writeFileSync(join(root, "keep.txt"), String(html.length));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
