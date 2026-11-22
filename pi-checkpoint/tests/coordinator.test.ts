import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckpointStore, type Snapshot } from "../src/checkpoint-store.js";
import { createCheckpointCoordinator } from "../src/coordinator.js";
import { createDiffPreview, type DiffPreview } from "../src/diff.js";
import { createGitRunner, GitUnavailableError } from "../src/git.js";
import { checkpointRef } from "../src/refs.js";
import { CHECKPOINT_ENTRY_TYPE, type CheckpointEntryData } from "../src/session.js";
import { commitAll, createTestRepo, git, writeRepoFile } from "./helpers/git-repo.js";

const normalPreview: DiffPreview = {
	shortstat: "1 file changed",
	patchPreview: "diff --git a/file b/file",
	previewTruncated: false,
	previewError: null,
};

function anchor(): SessionEntry {
	return { type: "custom", id: "before", parentId: null, timestamp: "2026-11-21T00:00:00.000Z", customType: "other" };
}

function sourceMessage(): SessionMessageEntry {
	return {
		type: "message",
		id: "source-user",
		parentId: "before",
		timestamp: "2026-11-21T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: "do work" }], timestamp: 1 },
	};
}

function startEvent(messageType: "user" | "custom" = "user"): BeforeAgentStartEvent {
	if (messageType === "custom") {
		return {
			type: "before_agent_start",
			messageType,
			message: { role: "custom", customType: "automation", content: [], display: false, timestamp: 1 },
		} as BeforeAgentStartEvent;
	}
	return { type: "before_agent_start", messageType, prompt: "do work" } as BeforeAgentStartEvent;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeHarness(cwd = "/repo") {
	const ref = checkpointRef("session", "run-id");
	const baseline: Snapshot = {
		worktreeRoot: cwd,
		commonDir: `${cwd}/.git`,
		head: "head-before",
		ref,
		commit: "baseline-oid",
		tree: "baseline-tree",
	};
	const result: Snapshot = {
		...baseline,
		head: "head-after",
		commit: "result-oid",
		tree: "result-tree",
	};
	const store = {
		captureBaseline: vi.fn().mockResolvedValue(baseline),
		captureResult: vi.fn().mockResolvedValue(result),
	};
	const preview = vi.fn().mockResolvedValue(normalPreview);
	const appendEntry = vi.fn();
	const notify = vi.fn();
	const pi = { appendEntry } as unknown as Pick<ExtensionAPI, "appendEntry">;
	const allEntries: SessionEntry[] = [anchor()];
	const branch: SessionEntry[] = [anchor(), sourceMessage()];
	const ctx = {
		cwd,
		sessionManager: {
			getLeafId: () => "before",
			getSessionId: () => "session",
			getEntries: () => allEntries,
			getBranch: () => branch,
		},
		ui: { notify },
	} as unknown as ExtensionContext;
	const coordinator = createCheckpointCoordinator({
		pi,
		store,
		preview,
		randomUUID: () => "run-id",
		now: () => new Date("2026-11-21T00:00:02.000Z"),
	});
	return { baseline, result, store, preview, appendEntry, notify, ctx, coordinator, allEntries, branch };
}

function appendedData(appendEntry: ReturnType<typeof vi.fn>, index = 0): CheckpointEntryData {
	const call = appendEntry.mock.calls[index];
	expect(call?.[0]).toBe(CHECKPOINT_ENTRY_TYPE);
	return call?.[1] as CheckpointEntryData;
}

describe("CheckpointCoordinator", () => {
	it("records an aborted user run with its source and repository state", async () => {
		const h = makeHarness();
		await h.coordinator.beforeAgentStart(startEvent(), h.ctx);
		await h.coordinator.agentSettled({ type: "agent_settled", aborted: true }, h.ctx);

		const data = appendedData(h.appendEntry);
		expect(data).toMatchObject({
			status: "ok",
			runId: "run-id",
			runNumber: 1,
			previousLeafId: "before",
			sourceEntryId: "source-user",
			aborted: true,
			ref: h.baseline.ref,
			baselineCommit: "baseline-oid",
			resultCommit: "result-oid",
			headBefore: "head-before",
			headAfter: "head-after",
		});
		expect(h.store.captureBaseline).toHaveBeenCalledTimes(1);
		expect(h.store.captureResult).toHaveBeenCalledTimes(1);
	});

	it("records the repository common dir so later queries can verify the snapshot elsewhere", async () => {
		const h = makeHarness();
		await h.coordinator.beforeAgentStart(startEvent(), h.ctx);
		await h.coordinator.agentSettled({ type: "agent_settled", aborted: false }, h.ctx);
		expect(appendedData(h.appendEntry)).toMatchObject({ status: "ok", commonDir: `${h.ctx.cwd}/.git` });
	});

	it("keeps a confirmed no-change preview", async () => {
		const h = makeHarness();
		h.preview.mockResolvedValue({ ...normalPreview, shortstat: "", patchPreview: "" });
		await h.coordinator.beforeAgentStart(startEvent(), h.ctx);
		await h.coordinator.agentSettled({ type: "agent_settled", aborted: false }, h.ctx);
		expect(appendedData(h.appendEntry)).toMatchObject({ status: "ok", shortstat: "", patchPreview: "" });
	});

	it("does not infer a source message for custom runs", async () => {
		const h = makeHarness();
		await h.coordinator.beforeAgentStart(startEvent("custom"), h.ctx);
		await h.coordinator.agentSettled({ type: "agent_settled", aborted: false }, h.ctx);
		expect(appendedData(h.appendEntry)).toMatchObject({ status: "ok", messageType: "custom", sourceEntryId: null });
	});

	it("records baseline failure and does not capture a result", async () => {
		const h = makeHarness();
		h.store.captureBaseline.mockRejectedValue(new Error("baseline failed"));
		await h.coordinator.beforeAgentStart(startEvent(), h.ctx);
		await h.coordinator.agentSettled({ type: "agent_settled", aborted: false }, h.ctx);

		expect(appendedData(h.appendEntry)).toMatchObject({ status: "error", stage: "baseline", baselineCommit: null });
		expect(h.store.captureResult).not.toHaveBeenCalled();
	});

	it("records result failure with the existing baseline", async () => {
		const h = makeHarness();
		h.store.captureResult.mockRejectedValue(new Error("result failed"));
		await h.coordinator.beforeAgentStart(startEvent(), h.ctx);
		await h.coordinator.agentSettled({ type: "agent_settled", aborted: false }, h.ctx);

		expect(appendedData(h.appendEntry)).toMatchObject({
			status: "error",
			stage: "result",
			baselineCommit: h.baseline.commit,
		});
	});

	it("skips non-Git runs and warns once until reset", async () => {
		const h = makeHarness();
		h.store.captureBaseline.mockResolvedValue(null);
		for (let run = 0; run < 2; run++) {
			await h.coordinator.beforeAgentStart(startEvent(), h.ctx);
			await h.coordinator.agentSettled({ type: "agent_settled", aborted: false }, h.ctx);
		}
		expect(h.appendEntry).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledTimes(1);

		h.coordinator.reset();
		await h.coordinator.beforeAgentStart(startEvent(), h.ctx);
		expect(h.notify).toHaveBeenCalledTimes(2);
	});

	it("treats a missing Git executable as unavailable rather than a capture error", async () => {
		const h = makeHarness();
		h.store.captureBaseline.mockRejectedValue(new GitUnavailableError());
		await h.coordinator.beforeAgentStart(startEvent(), h.ctx);
		await h.coordinator.agentSettled({ type: "agent_settled", aborted: false }, h.ctx);

		expect(h.appendEntry).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledTimes(1);
		expect(h.store.captureResult).not.toHaveBeenCalled();
	});

	it("ignores a baseline that settles after reset", async () => {
		const h = makeHarness();
		const pending = deferred<Snapshot | null>();
		h.store.captureBaseline.mockReturnValue(pending.promise);
		const starting = h.coordinator.beforeAgentStart(startEvent(), h.ctx);
		h.coordinator.reset();
		pending.resolve(h.baseline);
		await starting;
		await h.coordinator.agentSettled({ type: "agent_settled", aborted: false }, h.ctx);

		expect(h.appendEntry).not.toHaveBeenCalled();
		expect(h.store.captureResult).not.toHaveBeenCalled();
	});

	it("ignores a result that settles after reset", async () => {
		const h = makeHarness();
		const pending = deferred<Snapshot>();
		h.store.captureResult.mockReturnValue(pending.promise);
		await h.coordinator.beforeAgentStart(startEvent(), h.ctx);
		const settling = h.coordinator.agentSettled({ type: "agent_settled", aborted: false }, h.ctx);
		h.coordinator.reset();
		pending.resolve(h.result);
		await settling;

		expect(h.appendEntry).not.toHaveBeenCalled();
		expect(h.preview).not.toHaveBeenCalled();
	});

	it("keeps completed snapshots when preview generation throws", async () => {
		const h = makeHarness();
		h.preview.mockRejectedValue(new Error("preview failed"));
		await h.coordinator.beforeAgentStart(startEvent(), h.ctx);
		await h.coordinator.agentSettled({ type: "agent_settled", aborted: false }, h.ctx);

		expect(appendedData(h.appendEntry)).toMatchObject({
			status: "ok",
			resultCommit: h.result.commit,
			patchPreview: null,
			previewError: "preview failed",
		});
	});
});

describe("CheckpointCoordinator real Git smoke test", () => {
	let cleanup: (() => Promise<void>) | undefined;
	afterEach(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	it("captures the net diff across beforeAgentStart and agentSettled", async () => {
		const repo = await createTestRepo();
		cleanup = repo.cleanup;
		await writeRepoFile(repo.dir, "file.txt", "before\n");
		await commitAll(repo.dir);
		const runGit = createGitRunner();
		const store = new CheckpointStore(runGit);
		const appendEntry = vi.fn();
		const ctx = {
			cwd: repo.dir,
			sessionManager: {
				getLeafId: () => "before",
				getSessionId: () => "session",
				getEntries: () => [anchor()],
				getBranch: () => [anchor(), sourceMessage()],
			},
			ui: { notify: vi.fn() },
		} as unknown as ExtensionContext;
		const coordinator = createCheckpointCoordinator({
			pi: { appendEntry } as unknown as Pick<ExtensionAPI, "appendEntry">,
			store,
			preview: (input) => createDiffPreview(input, runGit),
			randomUUID: () => "smoke-run",
		});

		await coordinator.beforeAgentStart(startEvent(), ctx);
		await writeRepoFile(repo.dir, "file.txt", "after\n");
		await coordinator.agentSettled({ type: "agent_settled", aborted: false }, ctx);
		const data = appendedData(appendEntry);
		expect(data.status).toBe("ok");
		if (data.status !== "ok") return;
		expect(await git(repo.dir, "diff", data.baselineCommit, data.resultCommit)).toContain("+after");
		expect(data.patchPreview).toContain("+after");
	});
});
