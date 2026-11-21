import { describe, expect, it } from "vitest";
import { isCheckpointRefName, selectRefsToDelete } from "../src/retention.js";

const day = 86_400;
const now = 1_800_000_000;

function record(name: string, daysAgo: number) {
	return { name: `refs/pi/checkpoint/${name}`, committedAtSeconds: now - daysAgo * day };
}

describe("checkpoint ref retention", () => {
	it("keeps refs inside both limits", () => {
		const records = [record("s1/run-a", 1), record("s1/run-b", 5)];
		expect(selectRefsToDelete(records, { nowSeconds: now, retentionDays: 30, maxRefs: 200 })).toEqual([]);
	});

	it("deletes refs older than the retention window", () => {
		const records = [record("s1/fresh", 3), record("s1/stale", 31)];
		expect(selectRefsToDelete(records, { nowSeconds: now, retentionDays: 30, maxRefs: 200 })).toEqual([
			"refs/pi/checkpoint/s1/stale",
		]);
	});

	it("keeps only the newest refs when the count limit binds", () => {
		const records = [record("s1/oldest", 4), record("s2/middle", 3), record("s3/newest", 1)];
		expect(selectRefsToDelete(records, { nowSeconds: now, retentionDays: 30, maxRefs: 2 })).toEqual([
			"refs/pi/checkpoint/s1/oldest",
		]);
	});

	it("selects globally by age instead of per session", () => {
		const records = [
			...Array.from({ length: 3 }, (_, index) => record(`busy/run-${index}`, index)),
			record("quiet/only-run", 20),
		];
		expect(selectRefsToDelete(records, { nowSeconds: now, retentionDays: 30, maxRefs: 2 })).toEqual([
			"refs/pi/checkpoint/busy/run-2",
			"refs/pi/checkpoint/quiet/only-run",
		]);
	});

	it("recognizes only two-segment checkpoint ref names", () => {
		expect(isCheckpointRefName("refs/pi/checkpoint/c2Vz/run-1")).toBe(true);
		expect(isCheckpointRefName("refs/pi/checkpoint/c2Vz")).toBe(false);
		expect(isCheckpointRefName("refs/pi/checkpoint/a/b/c")).toBe(false);
		expect(isCheckpointRefName("refs/pi/checkpoint/a/")).toBe(false);
		expect(isCheckpointRefName("refs/heads/main")).toBe(false);
	});
});
