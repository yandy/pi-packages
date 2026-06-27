/**
 * workspace-bracket.ts — Owned prepare/dispose lifecycle for a child workspace.
 *
 * Captures the provider resolver (not the provider itself) so provider
 * resolution stays lazy at run-start. The prepared Workspace is held
 * privately; dispose() centralises the guard and addendum-unwrap so callers
 * never reach through to workspace.dispose().resultAddendum directly.
 *
 * dispose() deliberately does NOT catch errors — the best-effort try/catch
 * for failRun() belongs at the call site, preserving the per-caller semantics.
 */

import type {
	Workspace,
	WorkspaceDisposeOutcome,
	WorkspacePrepareContext,
	WorkspaceProvider,
} from "../lifecycle/workspace";

/** Owns the child workspace lifecycle: prepare at run-start, dispose at run-end. */
export class WorkspaceBracket {
	private prepared?: Workspace;

	constructor(private readonly resolveProvider: () => WorkspaceProvider | undefined) {}

	/**
	 * Returns true when a workspace provider is currently registered.
	 * Use to guard the `await prepare(...)` call and avoid an unnecessary
	 * microtask boundary in the no-provider path.
	 */
	hasProvider(): boolean {
		return this.resolveProvider() !== undefined;
	}

	/**
	 * Resolve the registered provider and prepare the child workspace.
	 * Returns the workspace's cwd, or undefined when no provider is registered
	 * or the provider resolves to undefined.
	 */
	async prepare(ctx: WorkspacePrepareContext): Promise<string | undefined> {
		const provider = this.resolveProvider();
		if (!provider) return undefined;
		this.prepared = await provider.prepare(ctx);
		return this.prepared?.cwd;
	}

	/**
	 * Dispose the prepared workspace (if any) and return the result addendum
	 * verbatim. Returns an empty string when no workspace was prepared or when
	 * the workspace returns no addendum.
	 *
	 * Throws propagate — wrap in try/catch at the call site when best-effort
	 * disposal is desired (e.g. failRun).
	 */
	dispose(outcome: WorkspaceDisposeOutcome): string {
		if (!this.prepared) return "";
		return this.prepared.dispose(outcome)?.resultAddendum ?? "";
	}
}
