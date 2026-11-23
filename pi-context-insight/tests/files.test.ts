import { describe, expect, it } from "vitest";
import { aggregateFiles, collectFileOps } from "../src/activity/files";
import {
	assistantEntry,
	resetEntryIds,
	toolCall,
	toolResultEntry,
	userEntry,
} from "./helpers/entries";

function run(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>, results: Array<{ id: string; name: string; content: unknown[] | string; isError?: boolean }>) {
	resetEntryIds();
	const entries = [userEntry("hi", 0)];
	let t = 1;
	for (const call of calls) entries.push(assistantEntry({ content: [toolCall(call.id, call.name, call.args)], timestamp: t++ }));
	for (const result of results) {
		entries.push(
			toolResultEntry({
				toolCallId: result.id,
				toolName: result.name,
				content: result.content,
				isError: result.isError ?? false,
				timestamp: t++,
			}),
		);
	}
	return collectFileOps({ entries });
}

describe("collectFileOps", () => {
	it("counts added and removed lines for every edit segment", () => {
		const ops = run(
			[{ id: "c1", name: "edit", args: { path: "a.ts", edits: [{ oldText: "a\nb", newText: "a" }, { oldText: "c", newText: "c\nd\ne" }] } }],
			[{ id: "c1", name: "edit", content: "ok" }],
		);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ kind: "write", added: 4, removed: 3 });
	});
	it("counts writes as added lines only", () => {
		const ops = run([{ id: "c1", name: "write", args: { path: "b.ts", content: "1\n2\n3" } }], [{ id: "c1", name: "write", content: "ok" }]);
		expect(ops[0]).toMatchObject({ kind: "write", added: 3, removed: 0 });
	});
	it("records read ranges as estimates", () => {
		const ops = run([{ id: "c1", name: "read", args: { path: "c.ts", offset: 10, limit: 5 } }], [{ id: "c1", name: "read", content: "x" }]);
		expect(ops[0]).toMatchObject({ kind: "read", readRange: { start: 10, count: 5, estimated: true } });
	});
	it("splits grep results into one operation per file", () => {
		const ops = run(
			[{ id: "c1", name: "grep", args: { pattern: "needle", path: "src" } }],
			[{ id: "c1", name: "grep", content: "src/a.ts:3: needle\nsrc/a.ts:9: needle\nsrc/b.ts:1: needle" }],
		);
		const byPath = new Map(ops.map((op) => [op.path, op.hits]));
		expect(byPath.get("src/a.ts")).toBe(2);
		expect(byPath.get("src/b.ts")).toBe(1);
		expect(ops.every((op) => op.kind === "search")).toBe(true);
	});
	it("falls back to the searched path when grep output is unparsable", () => {
		const ops = run([{ id: "c1", name: "grep", args: { pattern: "needle", path: "src" } }], [{ id: "c1", name: "grep", content: "No matches found" }]);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.patternOnly).toBe(true);
	});
	it("creates no operation for a call without a result", () => {
		const ops = run([{ id: "c1", name: "read", args: { path: "d.ts" } }], []);
		expect(ops).toHaveLength(0);
	});
	it("counts images separately", () => {
		const ops = run(
			[{ id: "c1", name: "read", args: { path: "pic.png" } }],
			[{ id: "c1", name: "read", content: [{ type: "image", data: "x", mimeType: "image/png" }] }],
		);
		expect(ops.some((op) => op.kind === "image")).toBe(true);
	});
	it("aggregates and sorts rows", () => {
		const ops = run(
			[
				{ id: "c1", name: "read", args: { path: "z.ts" } },
				{ id: "c2", name: "write", args: { path: "a.ts", content: "1\n2" } },
				{ id: "c3", name: "read", args: { path: "z.ts" } },
			],
			[
				{ id: "c1", name: "read", content: "x" },
				{ id: "c2", name: "write", content: "ok" },
				{ id: "c3", name: "read", content: "y" },
			],
		);
		const byLines = aggregateFiles(ops, "lines");
		expect(byLines[0]?.path).toBe("a.ts");
		const byCount = aggregateFiles(ops, "count");
		expect(byCount[0]?.path).toBe("z.ts");
		expect(byCount[0]?.counts.read).toBe(2);
	});
});
