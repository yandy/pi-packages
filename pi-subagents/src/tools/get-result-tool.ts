import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AgentConfigLookup } from "../config/agent-types";
import { formatLifetimeTokens, textResult } from "../tools/helpers";
import type { Subagent } from "../types";
import { formatDuration, getDisplayName } from "../ui/display";

// ---- Deps interfaces ----

export interface GetResultToolManager {
	getRecord(id: string): Subagent | undefined;
}

export interface GetResultToolNotifications {
	cancelNudge(key: string): void;
}

// ---- Class ----

export class GetResultTool {
	constructor(
		private readonly manager: GetResultToolManager,
		private readonly notifications: GetResultToolNotifications,
		private readonly registry: AgentConfigLookup,
	) {}

	async execute(
		_toolCallId: string,
		params: { agent_id: string; wait?: boolean; verbose?: boolean },
		_signal: AbortSignal,
		_onUpdate: unknown,
		_ctx: unknown,
	) {
		const record = this.manager.getRecord(params.agent_id);
		if (!record) {
			return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
		}

		// Wait for completion if requested.
		// Pre-mark resultConsumed BEFORE awaiting: onComplete fires inside .then()
		// (attached earlier at spawn time) and always runs before this await resumes.
		// Setting the flag here prevents a redundant follow-up notification.
		if (params.wait && record.status === "running" && record.promise) {
			// Pre-mark consumed BEFORE awaiting — onComplete fires inside .then() and
			// always runs before this await resumes. Prevents a redundant notification.
			record.notification?.markConsumed();
			this.notifications.cancelNudge(params.agent_id);
			await record.promise;
		}

		const displayName = getDisplayName(record.type, this.registry);
		const duration = formatDuration(record.startedAt, record.completedAt);
		const tokens = formatLifetimeTokens(record);
		const contextPercent = record.getContextPercent();
		const statsParts = [`Tool uses: ${record.toolUses}`];
		if (tokens) statsParts.push(tokens);
		if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
		if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
		statsParts.push(`Duration: ${duration}`);

		let output =
			`Agent: ${record.id}\n` +
			`Type: ${displayName} | Status: ${record.status} | ${statsParts.join(" | ")}\n` +
			`Description: ${record.description}\n\n`;

		if (record.status === "running") {
			output += "Agent is still running. Use wait: true or check back later.";
		} else if (record.status === "error") {
			output += `Error: ${record.error}`;
		} else {
			output += record.result?.trim() ?? "No output.";
		}

		// Mark result as consumed — suppresses the completion notification
		if (record.status !== "running" && record.status !== "queued") {
			record.notification?.markConsumed();
			this.notifications.cancelNudge(params.agent_id);
		}

		// Verbose: include full conversation
		const conversation = params.verbose ? record.getConversation() : undefined;
		if (conversation) {
			output += `\n\n--- Agent Conversation ---\n${conversation}`;
		}

		return textResult(output);
	}

	toToolDefinition() {
		return defineTool({
			name: "get_subagent_result" as const,
			label: "Get Agent Result",
			promptSnippet:
				"get_subagent_result: Check status and retrieve results from a background agent.",
			description:
				"Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
			parameters: Type.Object({
				agent_id: Type.String({
					description: "The agent ID to check.",
				}),
				wait: Type.Optional(
					Type.Boolean({
						description:
							"If true, wait for the agent to complete before returning. Default: false.",
					}),
				),
				verbose: Type.Optional(
					Type.Boolean({
						description:
							"If true, include the agent's full conversation (messages + tool calls). Default: false.",
					}),
				),
			}),
			execute: (
				toolCallId: string,
				params: { agent_id: string; wait?: boolean; verbose?: boolean },
				signal: AbortSignal,
				onUpdate: unknown,
				ctx: unknown,
			) => this.execute(toolCallId, params, signal, onUpdate, ctx),
		});
	}
}
