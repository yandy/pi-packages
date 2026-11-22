import type { CustomEntry, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CheckpointCommandDeps,
	createCheckpointCommandHandler,
	type PruneCommandOptions,
	type SnapshotResolution,
} from "../src/command.js";
import type { PruneResult } from "../src/retention.js";
import { CHECKPOINT_ENTRY_TYPE, type CheckpointOkData } from "../src/session.js";

const ref = "refs/pi/checkpoint/c2Vzc2lvbg/run-7";

function okData(overrides: Partial<CheckpointOkData> = {}): CheckpointOkData {
	return {
		version: 1,
		status: "ok",
		runId: "run-7",
		runNumber: 7,
		previousLeafId: "before",
		sourceEntryId: "source",
		messageType: "user",
		startedAt: "2026-11-21T00:00:00.000Z",
		settledAt: "2026-11-21T00:00:01.000Z",
		aborted: false,
		ref,
		baselineCommit: "baseline-oid",
		resultCommit: "result-oid",
		headBefore: "head-before",
		headAfter: "head-after",
		shortstat: "1 file changed",
		patchPreview: "diff --git a/file b/file",
		previewTruncated: false,
		previewError: null,
		commonDir: "/repo/.git",
		...overrides,
	};
}

function checkpointEntry(data: CheckpointOkData = okData()): CustomEntry {
	return {
		type: "custom",
		customType: CHECKPOINT_ENTRY_TYPE,
		data,
		id: "checkpoint-entry",
		parentId: "assistant",
		timestamp: "2026-11-21T00:00:01.000Z",
	};
}

function pruneResult(overrides: Partial<PruneResult> = {}): PruneResult {
	return {
		dryRun: false,
		completed: 5,
		baselineOnly: 0,
		unknown: 0,
		expired: 2,
		overflow: 1,
		selected: 3,
		deleted: 3,
		kept: 2,
		retentionDays: 30,
		maxRefs: 200,
		...overrides,
	};
}

function resolved(): SnapshotResolution {
	return { state: "resolved", oid: "result-oid" };
}

function deps(overrides: Partial<CheckpointCommandDeps> = {}): CheckpointCommandDeps {
	return {
		prune: async () => null,
		probeSnapshot: async () => resolved(),
		...overrides,
	};
}

describe("/checkpoint", () => {
	let notify: ReturnType<typeof vi.fn>;
	let ctx: ExtensionCommandContext;

	function makeCtx(data: CheckpointOkData = okData()): ExtensionCommandContext {
		return {
			cwd: "/repo",
			sessionManager: {
				getBranch: () => [checkpointEntry(data)],
				getEntries: () => [checkpointEntry(data)],
			},
			ui: { notify },
		} as unknown as ExtensionCommandContext;
	}

	beforeEach(() => {
		notify = vi.fn();
		ctx = makeCtx();
	});

	function outputOf(call = 0): string {
		return String(notify.mock.calls[call]?.[0] ?? "");
	}

	it("shows the ref and a diff command that carries the recorded repository", async () => {
		const probeSnapshot = vi.fn(async () => resolved());
		await createCheckpointCommandHandler(deps({ probeSnapshot }))("7", ctx);

		expect(probeSnapshot).toHaveBeenCalledWith("/repo/.git", ref);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining(ref), "info");
		expect(outputOf()).toContain("baseline-oid");
		expect(outputOf()).toContain("result-oid");
		expect(outputOf()).toContain("git --git-dir=/repo/.git diff baseline-oid result-oid");
	});

	it("uses the current directory and a plain command for legacy entries", async () => {
		const legacy = makeCtx(okData({ commonDir: undefined }));
		const probeSnapshot = vi.fn(async () => resolved());
		await createCheckpointCommandHandler(deps({ probeSnapshot }))("7", legacy);

		expect(probeSnapshot).toHaveBeenCalledWith("/repo", ref);
		expect(outputOf()).toContain("git diff baseline-oid result-oid");
		expect(outputOf()).not.toContain("--git-dir");
	});

	it("reports a pruned snapshot with its retained summary and no runnable command", async () => {
		const handler = createCheckpointCommandHandler(deps({ probeSnapshot: async () => ({ state: "absent" }) }));
		await handler("7", ctx);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("no longer exists"), "warning");
		expect(outputOf()).toContain("summary: 1 file changed");
		expect(outputOf()).toContain("diff --git a/file b/file");
		expect(outputOf()).not.toContain("--git-dir");
		expect(outputOf()).not.toContain("git diff baseline-oid result-oid");
	});

	it("reports a ref that moved away from the recorded result commit", async () => {
		const handler = createCheckpointCommandHandler(
			deps({ probeSnapshot: async () => ({ state: "resolved", oid: "0123456789abcdef" }) }),
		);
		await handler("7", ctx);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("now points to 0123456"), "warning");
		expect(outputOf()).toContain("summary: 1 file changed");
		expect(outputOf()).not.toContain("diff baseline-oid result-oid");
	});

	it("hedges for legacy entries whose ref cannot be found", async () => {
		const legacy = makeCtx(okData({ commonDir: undefined }));
		const handler = createCheckpointCommandHandler(deps({ probeSnapshot: async () => ({ state: "absent" }) }));
		await handler("7", legacy);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("may have been pruned"), "warning");
		expect(outputOf()).toContain("1 file changed");
		expect(outputOf()).not.toContain("git diff baseline-oid result-oid");
	});

	it("never reports a failed verification as a pruned snapshot", async () => {
		const handler = createCheckpointCommandHandler(
			deps({ probeSnapshot: async () => ({ state: "unverifiable", error: "git executable not found" }) }),
		);
		await handler("7", ctx);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("cannot confirm"), "warning");
		expect(outputOf()).toContain("git executable not found");
		expect(outputOf()).not.toContain("pruned");
		expect(outputOf()).not.toContain("no longer exists");
	});

	it("treats a throwing probe as unconfirmed, not as pruned", async () => {
		const handler = createCheckpointCommandHandler(
			deps({
				probeSnapshot: async () => {
					throw new Error("git rev-parse failed");
				},
			}),
		);
		await handler("7", ctx);

		expect(outputOf()).toContain("cannot confirm");
		expect(outputOf()).toContain("git rev-parse failed");
		expect(outputOf()).not.toContain("pruned");
	});

	it("shows usage for missing or invalid arguments", async () => {
		const handler = createCheckpointCommandHandler(deps());
		for (const input of ["", "not-a-number", "1.5", "7 8"]) {
			await handler(input, ctx);
		}
		expect(notify).toHaveBeenCalledTimes(4);
		for (const call of notify.mock.calls) {
			expect(String(call[0])).toContain("/checkpoint <runNumber>");
			expect(call[1]).toBe("warning");
		}
	});

	it("reports a missing checkpoint", async () => {
		await createCheckpointCommandHandler(deps())("404", ctx);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("not found"), "warning");
	});

	it("reports a pruned pass with the reasons it selected", async () => {
		const prune = vi.fn(async () => pruneResult());
		await createCheckpointCommandHandler(deps({ prune }))("prune", ctx);

		expect(prune).toHaveBeenCalledWith("/repo", expect.objectContaining({ dryRun: false }));
		expect(outputOf()).toContain("Pruned 3 checkpoint ref(s)");
		expect(outputOf()).toContain("2 older than 30 days");
		expect(outputOf()).toContain("1 beyond the newest 200");
		expect(outputOf()).toContain("2 kept");
	});

	it("plans a dry run with the same selection and reports it", async () => {
		const prune = vi.fn(async (_cwd: string, options: PruneCommandOptions) =>
			pruneResult({ dryRun: options.dryRun, deleted: 0, kept: 2 }),
		);
		await createCheckpointCommandHandler(deps({ prune }))("prune --dry-run", ctx);

		expect(prune).toHaveBeenCalledWith("/repo", expect.objectContaining({ dryRun: true }));
		expect(outputOf()).toContain("Checkpoint prune (dry run)");
		expect(outputOf()).toContain("would delete 3 of 5 completed checkpoint ref(s)");
		expect(outputOf()).toContain("2 older than 30 days");
		expect(outputOf()).toContain("1 beyond the newest 200");
		expect(outputOf()).toContain("2 would be kept");
	});

	it("mentions baseline-only refs that the sweep left alone", async () => {
		const prune = vi.fn(async () => pruneResult({ baselineOnly: 4, completed: 2, expired: 1, overflow: 0, selected: 1, deleted: 1, kept: 1 }));
		await createCheckpointCommandHandler(deps({ prune }))("prune", ctx);
		expect(outputOf()).toContain("4 baseline-only ref(s) left untouched");
	});

	it("hands the current session's recorded snapshots to the prune plan", async () => {
		const prune = vi.fn(async () => pruneResult());
		await createCheckpointCommandHandler(deps({ prune }))("prune", ctx);

		const options = prune.mock.calls[0]?.[1] as PruneCommandOptions;
		expect(options.recorded.get(ref)).toEqual({
			ref,
			baselineCommit: "baseline-oid",
			resultCommit: "result-oid",
		});
	});

	it("rejects an unknown prune argument without sweeping", async () => {
		const prune = vi.fn(async () => pruneResult());
		await createCheckpointCommandHandler(deps({ prune }))("prune --force", ctx);

		expect(prune).not.toHaveBeenCalled();
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("prune [--dry-run]"), "warning");
	});

	it("reports a prune outside a worktree as skipped", async () => {
		await createCheckpointCommandHandler(deps({ prune: async () => null }))("prune", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("not inside a Git worktree"), "info");
	});

	it("reports prune failures with a cleaned short error", async () => {
		const handler = createCheckpointCommandHandler(
			deps({
				prune: async () => {
					throw new Error("git update-ref failed\nsecond line");
				},
			}),
		);
		await handler("prune", ctx);
		expect(notify).toHaveBeenCalledWith("Checkpoint prune failed: git update-ref failed second line", "warning");
	});
});
