import { resolve } from "node:path";
import { GitCommandError, type GitResult, type RunGit } from "./git.js";

export interface RepositoryContext {
	worktreeRoot: string;
	commonDir: string;
	head: string | null;
}

/**
 * Resolves the enclosing worktree and the common dir shared by its linked worktrees.
 * Returns null when `cwd` is outside a Git worktree, including bare repositories.
 *
 * Git ref names and filesystem paths are distinct: callers get absolute, normalized paths.
 */
export async function resolveRepository(
	runGit: RunGit,
	cwd: string,
	signal?: AbortSignal,
): Promise<RepositoryContext | null> {
	const rootArgs = ["rev-parse", "--path-format=absolute", "--show-toplevel"];
	const rootResult = await runGit(rootArgs, {
		cwd,
		env: { LC_ALL: "C" },
		allowNonZeroExit: true,
		signal,
	});
	if (rootResult.code !== 0) {
		if (isNonWorktree(rootResult)) return null;
		throw new GitCommandError(rootArgs, rootResult);
	}
	const worktreeRoot = resolve(rootResult.stdout.trim());
	const commonArgs = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
	const commonResult = await runGit(commonArgs, { cwd: worktreeRoot, signal });
	const commonDir = resolve(commonResult.stdout.trim());
	const headArgs = ["rev-parse", "--verify", "--quiet", "HEAD"];
	const headResult = await runGit(headArgs, { cwd: worktreeRoot, allowNonZeroExit: true, signal });
	if (headResult.code !== 0 && headResult.code !== 1) {
		throw new GitCommandError(headArgs, headResult);
	}
	return {
		worktreeRoot,
		commonDir,
		head: headResult.code === 0 ? headResult.stdout.trim() : null,
	};
}

function isNonWorktree(result: GitResult): boolean {
	const stderr = result.stderr.toLowerCase();
	return (
		stderr.includes("not a git repository") ||
		stderr.includes("cannot use bare repository") ||
		stderr.includes("must be run in a work tree")
	);
}
