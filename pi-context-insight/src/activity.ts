import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ActivityReport, CommandActivity, FileActivity, TimingReport, ToolExecution, ToolSummary } from "./model";

type Args = Record<string, unknown>;

function asRecord(value: unknown): Args {
	return typeof value === "object" && value !== null ? (value as Args) : {};
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split(/\r\n|\r|\n/);
	if (/(?:\r\n|\r|\n)$/.test(text)) lines.pop();
	return lines.length;
}

function fileEntry(files: Map<string, FileActivity>, path: string): FileActivity {
	let file = files.get(path);
	if (!file) {
		file = { path, read: 0, written: 0, edited: 0, searched: 0, addedLines: 0, removedLines: 0 };
		files.set(path, file);
	}
	return file;
}

function collectFileOperation(files: Map<string, FileActivity>, name: string, rawArgs: unknown): void {
	const args = asRecord(rawArgs);
	const hasPath = typeof args.path === "string" && args.path.length > 0;
	if (name === "read" || name === "write" || name === "edit") {
		if (!hasPath) return;
		const file = fileEntry(files, args.path as string);
		if (name === "read") file.read++;
		if (name === "write") {
			file.written++;
			if (typeof args.content === "string") file.addedLines += countLines(args.content);
		}
		if (name === "edit") {
			file.edited++;
			if (Array.isArray(args.edits)) {
				for (const rawEdit of args.edits) {
					const edit = asRecord(rawEdit);
					if (typeof edit.oldText === "string") file.removedLines += countLines(edit.oldText);
					if (typeof edit.newText === "string") file.addedLines += countLines(edit.newText);
				}
			} else {
				if (typeof args.oldText === "string") file.removedLines += countLines(args.oldText);
				if (typeof args.newText === "string") file.addedLines += countLines(args.newText);
			}
		}
		return;
	}
	if (name === "grep" || name === "find" || name === "ls" || name === "ast_grep_search") {
		fileEntry(files, hasPath ? (args.path as string) : ".").searched++;
	}
}

function newExecution(id: string, name: string, nested: boolean, timestamp: string): ToolExecution {
	return { id, name, nested, status: "missing", timestamp, durationMs: undefined, durationEstimated: false };
}

function setDuration(execution: ToolExecution, durationMs: unknown, estimated: boolean): void {
	if (finiteNumber(durationMs) && durationMs >= 0) {
		execution.durationMs = durationMs;
		execution.durationEstimated = estimated;
	}
}

function newCommand(
	id: string,
	source: "bash" | "powershell",
	nested: boolean,
	command: string,
	timestamp: string,
): CommandActivity {
	return {
		id,
		source,
		nested,
		command,
		status: "missing",
		timestamp,
		exitCode: undefined,
		durationMs: undefined,
		durationEstimated: false,
	};
}

function summarizeExecutions(executions: readonly ToolExecution[]): ToolSummary[] {
	const summaries = new Map<string, ToolSummary>();
	for (const execution of executions) {
		const key = `${execution.name}\0${execution.nested}`;
		let summary = summaries.get(key);
		if (!summary) {
			summary = {
				name: execution.name,
				nested: execution.nested,
				calls: 0,
				ok: 0,
				errors: 0,
				missing: 0,
				unfinished: 0,
				durationMs: 0,
			};
			summaries.set(key, summary);
		}
		summary.calls++;
		if (execution.status === "ok") summary.ok++;
		else if (execution.status === "error") summary.errors++;
		else if (execution.status === "unfinished") summary.unfinished++;
		else summary.missing++;
		summary.durationMs += execution.durationMs ?? 0;
	}
	return [...summaries.values()];
}

export function analyzeActivity(entries: readonly SessionEntry[]): ActivityReport {
	const executions: ToolExecution[] = [];
	const executionById = new Map<string, ToolExecution>();
	const callTimestamps = new Map<string, number>();
	const commands: CommandActivity[] = [];
	const commandById = new Map<string, CommandActivity>();
	const files = new Map<string, FileActivity>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const execution = newExecution(block.id, block.name, false, entry.timestamp);
				executions.push(execution);
				executionById.set(block.id, execution);
				callTimestamps.set(block.id, message.timestamp);
				collectFileOperation(files, block.name, block.arguments);
				if (
					(block.name === "bash" || block.name === "powershell") &&
					typeof asRecord(block.arguments).command === "string"
				) {
					const command = newCommand(
						block.id,
						block.name,
						false,
						asRecord(block.arguments).command as string,
						entry.timestamp,
					);
					commands.push(command);
					commandById.set(block.id, command);
				}
			}
			continue;
		}
		if (message.role === "bashExecution") {
			commands.push({
				id: entry.id,
				source: "user-bash",
				nested: false,
				command: message.command,
				status: message.cancelled
					? "cancelled"
					: message.exitCode === undefined
						? "missing"
						: message.exitCode === 0
							? "ok"
							: "error",
				timestamp: entry.timestamp,
				exitCode: message.exitCode,
				durationMs: undefined,
				durationEstimated: false,
			});
			continue;
		}
		if (message.role !== "toolResult") continue;

		let execution = executionById.get(message.toolCallId);
		if (!execution) {
			execution = newExecution(message.toolCallId, message.toolName, false, entry.timestamp);
			executions.push(execution);
			executionById.set(message.toolCallId, execution);
		}
		execution.status = message.isError ? "error" : "ok";
		execution.timestamp = entry.timestamp;
		if (finiteNumber(message.durationMs)) setDuration(execution, message.durationMs, false);
		else {
			const startedAt = callTimestamps.get(message.toolCallId);
			if (startedAt !== undefined) setDuration(execution, Math.max(0, message.timestamp - startedAt), true);
		}

		const command = commandById.get(message.toolCallId);
		if (command) {
			const details = asRecord(message.details);
			const exitCode = finiteNumber(details.exitCode) ? details.exitCode : undefined;
			command.status =
				details.cancelled === true
					? "cancelled"
					: message.isError || (exitCode !== undefined && exitCode !== 0)
						? "error"
						: "ok";
			command.timestamp = entry.timestamp;
			command.exitCode = exitCode;
			command.durationMs = execution.durationMs;
			command.durationEstimated = execution.durationEstimated;
		}

		for (const nested of message.nestedCalls?.calls ?? []) {
			const id = `${message.toolCallId}/${nested.id}`;
			const nestedExecution = newExecution(id, nested.name, true, entry.timestamp);
			nestedExecution.status = nested.status === "ok" ? "ok" : nested.status === "error" ? "error" : "unfinished";
			setDuration(nestedExecution, nested.durationMs, false);
			executions.push(nestedExecution);
			collectFileOperation(files, nested.name, nested.arguments);
			if (
				(nested.name === "bash" || nested.name === "powershell") &&
				typeof asRecord(nested.arguments).command === "string"
			) {
				const nestedCommand = newCommand(
					id,
					nested.name,
					true,
					asRecord(nested.arguments).command as string,
					entry.timestamp,
				);
				nestedCommand.status = nested.status === "ok" ? "ok" : nested.status === "error" ? "error" : "missing";
				nestedCommand.durationMs = nestedExecution.durationMs;
				nestedCommand.durationEstimated = nestedExecution.durationEstimated;
				commands.push(nestedCommand);
			}
		}
	}

	return {
		executions,
		tools: summarizeExecutions(executions),
		files: [...files.values()],
		commands,
	};
}

export function analyzeTiming(entries: readonly SessionEntry[], executions: readonly ToolExecution[]): TimingReport {
	let startedAt: string | undefined;
	let endedAt: string | undefined;
	let startMs = Number.POSITIVE_INFINITY;
	let endMs = Number.NEGATIVE_INFINITY;
	let modelTimeMs = 0;
	let modelTimeIncomplete = false;

	for (const entry of entries) {
		const timestamp = Date.parse(entry.timestamp);
		if (Number.isFinite(timestamp)) {
			if (timestamp < startMs) {
				startMs = timestamp;
				startedAt = entry.timestamp;
			}
			if (timestamp > endMs) {
				endMs = timestamp;
				endedAt = entry.timestamp;
			}
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			if (finiteNumber(entry.message.durationMs)) modelTimeMs += entry.message.durationMs;
			else modelTimeIncomplete = true;
		}
	}
	if (!startedAt || !endedAt) {
		return { wallTimeMs: 0, modelTimeMs, toolTimeMs: 0, modelTimeIncomplete, toolTimeEstimated: false };
	}
	return {
		startedAt,
		endedAt,
		wallTimeMs: Math.max(0, endMs - startMs),
		modelTimeMs,
		toolTimeMs: executions.reduce((sum, execution) => sum + (execution.durationMs ?? 0), 0),
		modelTimeIncomplete,
		toolTimeEstimated: executions.some((execution) => execution.durationEstimated),
	};
}
