import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createGitRunner, type RunGit } from "./git.js";
import { checkpointCommitSubject } from "./refs.js";
import { resolveRepository, type RepositoryContext } from "./repository.js";

export type { RepositoryContext };

export interface Snapshot extends RepositoryContext {
	ref: string;
	commit: string;
	tree: string;
}

const INDEX_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.splitIndex=false"];

export class CheckpointStore {
	private readonly runGit: RunGit;

	constructor(runGit: RunGit = createGitRunner()) {
		this.runGit = runGit;
	}

	async captureBaseline(cwd: string, ref: string, signal?: AbortSignal): Promise<Snapshot | null> {
		const repository = await resolveRepository(this.runGit, cwd);
		if (!repository) return null;
		return this.capture(repository, ref, repository.head, "baseline", "", signal);
	}

	async captureResult(baseline: Snapshot, signal?: AbortSignal): Promise<Snapshot> {
		const repository = await resolveRepository(this.runGit, baseline.worktreeRoot);
		if (
			!repository ||
			repository.worktreeRoot !== baseline.worktreeRoot ||
			repository.commonDir !== baseline.commonDir
		) {
			throw new Error("Git repository identity changed during checkpoint run");
		}
		return this.capture(repository, baseline.ref, baseline.commit, "result", baseline.commit, signal);
	}

	private async capture(
		repository: RepositoryContext,
		ref: string,
		parent: string | null,
		kind: "baseline" | "result",
		expectedOld: string,
		signal?: AbortSignal,
	): Promise<Snapshot> {
		const temporaryDirectory = await mkdtemp(join(repository.commonDir, "pi-checkpoint-"));
		const env = {
			GIT_INDEX_FILE: join(temporaryDirectory, "index"),
			GIT_AUTHOR_NAME: "Pi Checkpoint",
			GIT_AUTHOR_EMAIL: "pi-checkpoint@localhost",
			GIT_COMMITTER_NAME: "Pi Checkpoint",
			GIT_COMMITTER_EMAIL: "pi-checkpoint@localhost",
		};
		const config = [
			...INDEX_CONFIG,
			"-c",
			"commit.gpgsign=false",
			"-c",
			`core.hooksPath=${join(temporaryDirectory, "hooks")}`,
		];
		try {
			if (repository.head) {
				await this.runGit([...config, "read-tree", repository.head], {
					cwd: repository.worktreeRoot,
					env,
					signal,
				});
			}
			await this.runGit([...config, "add", "-A", "--", "."], {
				cwd: repository.worktreeRoot,
				env,
				signal,
			});
			const treeResult = await this.runGit([...config, "write-tree"], {
				cwd: repository.worktreeRoot,
				env,
				signal,
			});
			const tree = treeResult.stdout.trim();
			const commitArgs = [...config, "commit-tree", tree];
			if (parent) commitArgs.push("-p", parent);
			commitArgs.push("-m", checkpointCommitSubject(kind, ref));
			const commitResult = await this.runGit(commitArgs, {
				cwd: repository.worktreeRoot,
				env,
				signal,
			});
			const commit = commitResult.stdout.trim();
			await this.runGit([...config, "update-ref", ref, commit, expectedOld], {
				cwd: repository.worktreeRoot,
				env,
				signal,
			});
			return { ...repository, ref, commit, tree };
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}
}
