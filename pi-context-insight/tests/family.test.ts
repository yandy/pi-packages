import { describe, expect, it } from "vitest";
import { collectFamily, type ChildSession, type SubagentRecord } from "../src/family";

function record(id: string, outputFile: string | undefined, over: Partial<SubagentRecord> = {}): SubagentRecord {
	return {
		id,
		type: "general-purpose",
		description: `task ${id}`,
		status: "completed",
		startedAt: 100,
		completedAt: 200,
		...(outputFile === undefined ? {} : { outputFile }),
		...over,
	};
}

function sessions(entries: Array<[string, ChildSession]>): (path: string) => ChildSession | undefined {
	const map = new Map(entries);
	return (path) => map.get(path);
}

describe("collectFamily", () => {
	it("walks nested children breadth first", () => {
		const { members } = collectFamily({
			parentSessionId: "root",
			records: [record("a", "a.jsonl")],
			loadChild: sessions([
				["a.jsonl", { id: "a", parentId: "root", steps: 3, records: [record("b", "b.jsonl")] }],
				["b.jsonl", { id: "b", parentId: "a", steps: 1, records: [] }],
			]),
		});
		expect(members.map((member) => [member.id, member.depth])).toEqual([
			["a", 1],
			["b", 2],
		]);
	});
	it("skips a child whose header names another parent", () => {
		const { members, warnings } = collectFamily({
			parentSessionId: "root",
			records: [record("a", "a.jsonl")],
			loadChild: sessions([["a.jsonl", { id: "a", parentId: "elsewhere", steps: 1, records: [] }]]),
		});
		expect(members).toEqual([]);
		expect(warnings.map((warning) => warning.key)).toContain("warning.lineageMismatch");
	});
	it("warns about a damaged child instead of failing", () => {
		const { members, warnings } = collectFamily({
			parentSessionId: "root",
			records: [record("a", "a.jsonl")],
			loadChild: () => undefined,
		});
		expect(members).toEqual([]);
		expect(warnings.map((warning) => warning.key)).toContain("warning.brokenChild");
	});
	it("marks records without a status as untracked", () => {
		const { members } = collectFamily({
			parentSessionId: "root",
			records: [record("a", "a.jsonl", { status: "" })],
			loadChild: sessions([["a.jsonl", { id: "a", parentId: "root", steps: 1, records: [] }]]),
		});
		expect(members[0]?.status).toBe("untracked");
	});
	it("stops at the depth limit", () => {
		const chain: Array<[string, ChildSession]> = [];
		for (let index = 0; index < 4; index++) {
			chain.push([
				`${index}.jsonl`,
				{ id: `${index}`, parentId: index === 0 ? "root" : `${index - 1}`, steps: 1, records: [record(`${index + 1}`, `${index + 1}.jsonl`)] },
			]);
		}
		const { members, warnings } = collectFamily({
			parentSessionId: "root",
			records: [record("0", "0.jsonl")],
			loadChild: sessions(chain),
			maxDepth: 2,
		});
		expect(members.map((member) => member.depth)).toEqual([1, 2]);
		expect(warnings.map((warning) => warning.key)).toContain("warning.depthLimit");
	});
	it("keeps the first visit when a session is referenced twice", () => {
		const { members } = collectFamily({
			parentSessionId: "root",
			records: [record("a", "a.jsonl"), record("a", "a.jsonl")],
			loadChild: sessions([["a.jsonl", { id: "a", parentId: "root", steps: 1, records: [] }]]),
		});
		expect(members).toHaveLength(1);
	});
});
