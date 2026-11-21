import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/checkpoint-store.js";
import { createDiffPreview, type DiffInput } from "../src/diff.js";
import { createGitRunner, type RunGit } from "../src/git.js";
import { checkpointRef } from "../src/refs.js";
import { commitAll, createTestRepo, type TestRepo, writeRepoFile } from "./helpers/git-repo.js";

describe("createDiffPreview", () => {
	let repo: TestRepo;
	let store: CheckpointStore;

	beforeEach(async () => {
		repo = await createTestRepo();
		store = new CheckpointStore();
	});

	afterEach(async () => {
		await repo.cleanup();
	});

	async function snapshotPair(name: string, before: string | Buffer, after: string | Buffer): Promise<DiffInput> {
		await writeRepoFile(repo.dir, name, before);
		await commitAll(repo.dir, `${name} before`);
		const baseline = await store.captureBaseline(repo.dir, checkpointRef("diff-session", name));
		if (!baseline) throw new Error("Expected a baseline");
		await writeRepoFile(repo.dir, name, after);
		const result = await store.captureResult(baseline);
		return { cwd: repo.dir, baselineCommit: baseline.commit, resultCommit: result.commit };
	}

	it("returns shortstat and a patch for a normal change", async () => {
		const input = await snapshotPair("file.txt", "before\n", "after\n");
		const preview = await createDiffPreview(input);

		expect(preview.shortstat).toContain("file changed");
		expect(preview.patchPreview).toContain("diff --git");
		expect(preview.patchPreview).toContain("+after");
		expect(preview.previewTruncated).toBe(false);
		expect(preview.previewError).toBeNull();
	});

	it("uses empty strings for a confirmed empty diff", async () => {
		const input = await snapshotPair("file.txt", "same\n", "same\n");
		const preview = await createDiffPreview(input);

		expect(preview.shortstat).toBe("");
		expect(preview.patchPreview).toBe("");
		expect(preview.previewTruncated).toBe(false);
		expect(preview.previewError).toBeNull();
	});

	it("bounds a large UTF-8 patch to 128 KiB without exceeding the byte limit", async () => {
		const input = await snapshotPair("large.txt", "before\n", `${"界".repeat(50_000)}\n`);
		const preview = await createDiffPreview(input);

		expect(preview.previewTruncated).toBe(true);
		expect(preview.patchPreview).not.toBeNull();
		expect(Buffer.byteLength(preview.patchPreview ?? "", "utf8")).toBeLessThanOrEqual(131_072);
		expect(preview.patchPreview).not.toContain("�");
		expect(preview.previewError).toBeNull();
	});

	it("keeps binary patches as binary metadata rather than raw binary content", async () => {
		const input = await snapshotPair(
			"binary.bin",
			Buffer.from([0, 1, 2, 3]),
			Buffer.from([0, 1, 9, 3]),
		);
		const preview = await createDiffPreview(input);

		expect(preview.patchPreview).toContain("Binary files");
		expect(preview.previewError).toBeNull();
	});

	it("keeps the patch when shortstat fails or is truncated", async () => {
		const input = await snapshotPair("file.txt", "before\n", "after\n");
		const run = createGitRunner();
		const failed: RunGit = async (args, options) => {
			if (args.includes("--shortstat")) {
				return { stdout: "", stderr: "injected shortstat failure", code: 1, killed: false, truncated: false };
			}
			return run(args, options);
		};
		const failedPreview = await createDiffPreview(input, failed);

		expect(failedPreview.shortstat).toBeNull();
		expect(failedPreview.patchPreview).toContain("diff --git");
		expect(failedPreview.previewError).toContain("shortstat");

		const truncated: RunGit = async (args, options) => {
			if (args.includes("--shortstat")) {
				return { stdout: "1 file", stderr: "", code: null, killed: true, truncated: true };
			}
			return run(args, options);
		};
		const truncatedPreview = await createDiffPreview(input, truncated);
		expect(truncatedPreview.shortstat).toBeNull();
		expect(truncatedPreview.patchPreview).toContain("diff --git");
		expect(truncatedPreview.previewError).toContain("shortstat");
	});

	it("keeps shortstat when the patch fails", async () => {
		const input = await snapshotPair("file.txt", "before\n", "after\n");
		const run = createGitRunner();
		const failed: RunGit = async (args, options) => {
			if (args.includes("--patch")) {
				return { stdout: "", stderr: "injected patch failure", code: 1, killed: false, truncated: false };
			}
			return run(args, options);
		};
		const preview = await createDiffPreview(input, failed);

		expect(preview.shortstat).toContain("file changed");
		expect(preview.patchPreview).toBeNull();
		expect(preview.previewTruncated).toBe(false);
		expect(preview.previewError).toContain("patch");
	});

	it("passes cancellation and hardened diff flags to both Git commands", async () => {
		const input = await snapshotPair("file.txt", "before\n", "after\n");
		const run = createGitRunner();
		const controller = new AbortController();
		const signals: Array<AbortSignal | undefined> = [];
		const observedArgs: string[][] = [];
		const observingRun: RunGit = async (args, options) => {
			signals.push(options.signal);
			observedArgs.push(args);
			return run(args, options);
		};
		await createDiffPreview({ ...input, signal: controller.signal }, observingRun);

		expect(signals).toEqual([controller.signal, controller.signal]);
		expect(observedArgs).toHaveLength(2);
		for (const args of observedArgs) {
			expect(args).toContain("--no-color");
			expect(args).toContain("--no-ext-diff");
			expect(args).toContain("--no-textconv");
			expect(args).not.toContain("--binary");
		}
	});
});
