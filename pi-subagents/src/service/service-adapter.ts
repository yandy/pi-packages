/**
 * service-adapter.ts — Adapter that wraps SubagentManager to satisfy SubagentsService.
 *
 * Handles model resolution at the API boundary, record serialization
 * (stripping non-serializable fields), and session gating.
 */

import type { ParentSnapshot } from "../lifecycle/parent-snapshot";
import type { WorkspaceProvider } from "../lifecycle/workspace";
import type { SpawnOptions, SubagentRecord, SubagentsService } from "../service/service";
import type { ModelRegistry } from "../session/model-resolver";
import { resolveModelName } from "../tools/spawn-config";
import type { SessionContext, Subagent } from "../types";

/** Narrow interface for the SubagentManager — avoids coupling to the concrete class. */
export interface SubagentManagerLike {
	spawn(snapshot: ParentSnapshot, type: string, prompt: string, options: unknown): string;
	getRecord(id: string): Subagent | undefined;
	listAgents(): Subagent[];
	abort(id: string): boolean;
	waitForAll(): Promise<void>;
	hasRunning(): boolean;
	registerWorkspaceProvider(provider: WorkspaceProvider): () => void;
}

/**
 * Narrow runtime interface consumed by the service adapter.
 * `SubagentRuntime` satisfies this structurally; tests use plain stubs.
 */
export interface ServiceRuntimeLike {
	readonly currentCtx: SessionContext | undefined;
	buildSnapshot(inheritContext: boolean): ParentSnapshot;
}

/** Adapter that wraps SubagentManager to satisfy SubagentsService. */
export class SubagentsServiceAdapter implements SubagentsService {
	constructor(
		private readonly manager: SubagentManagerLike,
		private readonly resolveModel: (input: string, registry: ModelRegistry) => unknown,
		private readonly runtime: ServiceRuntimeLike,
	) {}

	spawn(type: string, prompt: string, options?: SpawnOptions): string {
		if (!this.runtime.currentCtx) {
			throw new Error("No active session — cannot spawn agents outside a session.");
		}

		let model: unknown;
		let modelName: string | undefined;
		if (options?.model) {
			const registry = this.runtime.currentCtx.modelRegistry;
			if (!registry) {
				throw new Error("No model registry available.");
			}
			const resolved = this.resolveModel(options.model, registry);
			if (typeof resolved === "string") {
				throw new Error(resolved);
			}
			model = resolved;
		}
		// Always compute display model name, even when same as parent
		modelName = resolveModelName(
			(model as { id?: string; name?: string } | undefined) ??
				(this.runtime.currentCtx.model as { id?: string; name?: string } | undefined),
		);

		const description = options?.description ?? prompt.slice(0, 80);
		const isBackground = !(options?.foreground ?? false);

		const snapshot = this.runtime.buildSnapshot(options?.inheritContext ?? false);
		return this.manager.spawn(snapshot, type, prompt, {
			description,
			model,
			maxTurns: options?.maxTurns,
			thinkingLevel: options?.thinkingLevel,
			inheritContext: options?.inheritContext,
			bypassQueue: options?.bypassQueue,
			isBackground,
			// Service API builds a display-minimal invocation (modelName only);
			// the tool path additionally carries thinking/maxTurns/inherit tags.
			invocation: modelName != null ? { modelName } : undefined,
		});
	}

	getRecord(id: string): SubagentRecord | undefined {
		const record = this.manager.getRecord(id);
		return record ? toSubagentRecord(record) : undefined;
	}

	listAgents(): SubagentRecord[] {
		return this.manager.listAgents().map(toSubagentRecord);
	}

	abort(id: string): boolean {
		return this.manager.abort(id);
	}

	async steer(id: string, message: string): Promise<boolean> {
		const record = this.manager.getRecord(id);
		if (record?.status !== "running") {
			return false;
		}
		await record.steer(message);
		return true;
	}

	async waitForAll(): Promise<void> {
		return this.manager.waitForAll();
	}

	hasRunning(): boolean {
		return this.manager.hasRunning();
	}

	registerWorkspaceProvider(provider: WorkspaceProvider): () => void {
		return this.manager.registerWorkspaceProvider(provider);
	}
}

/**
 * Convert an internal Subagent to a serializable SubagentRecord.
 * Uses an explicit allowlist — new fields must be opted in.
 */
export function toSubagentRecord(record: Subagent): SubagentRecord {
	const out: SubagentRecord = {
		id: record.id,
		type: record.type,
		description: record.description,
		status: record.status,
		toolUses: record.toolUses,
		startedAt: record.startedAt,
		lifetimeUsage: record.lifetimeUsage,
		compactionCount: record.compactionCount,
	};

	if (record.result !== undefined) out.result = record.result;
	if (record.error !== undefined) out.error = record.error;
	if (record.completedAt !== undefined) out.completedAt = record.completedAt;
	if (record.modelName !== undefined) out.modelName = record.modelName;

	return out;
}
