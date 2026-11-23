import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stepIndexOf } from "../session/steps";

export type CommandStatus = "ok" | "error" | "cancelled" | "missing" | "unfinished";

export interface CommandRecord {
	id: string;
	tool: "bash" | "powershell" | "user-bash" | "nested";
	program: string;
	command: string;
	status: CommandStatus;
	exitCode?: number;
	exitInferred: boolean;
	timestamp: number;
	durationMs?: number;
	durationEstimated: boolean;
	stepIndex: number;
	nested: boolean;
	lineCount: number;
	heredoc: boolean;
	outputChars: number;
	stderr: boolean;
	timedOut: boolean;
	denied: boolean;
}

export interface CommandReport {
	records: CommandRecord[];
	runs: number;
	failed: number;
	totalMs: number;
	nested: number;
	programs: Array<{ name: string; runs: number; records: number }>;
	notable: {
		slowest?: CommandRecord;
		mostFailing?: { name: string; count: number };
		mostRepeated?: { command: string; count: number };
		longestOutput?: CommandRecord;
	};
}

const WRAPPERS = new Set([
	"env",
	"sudo",
	"doas",
	"command",
	"exec",
	"time",
	"nohup",
	"nice",
	"stdbuf",
	"timeout",
	"caffeinate",
]);
const SHELL_KEYWORDS = /^(if|then|else|elif|for|while|until|case|do|done|fi|esac|function|select|coproc|\{|\()\b/;

function normalizeProgram(raw: string): string {
	let name = raw.trim();
	const lastSlash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
	if (lastSlash >= 0) name = name.slice(lastSlash + 1);
	return name.replace(/\.(exe|cmd|bat)$/i, "");
}

function firstSegment(command: string): string {
	const trimmed = command.trim();
	if (trimmed.length === 0) return "";
	const withoutComments = trimmed.replace(/^#.*$/gm, "").trim();
	const line = withoutComments.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? "";
	return line.trim();
}

/** Best-effort program name: first command word after stripping wrappers, `cd` prefixes and assignments. */
export function programOfCommand(tool: string, command: string): string {
	if (tool === "run_code") return "run_code";
	let line = firstSegment(command);
	if (line.length === 0) return tool === "powershell" ? "pwsh" : "shell";

	for (let guard = 0; guard < 8; guard++) {
		line = line.replace(/^[!&.\s]+/, "");
		const cdMatch = /^cd\s+\S+\s*(?:&&|;)\s*(.*)$/.exec(line);
		if (cdMatch) {
			line = cdMatch[1] ?? "";
			continue;
		}
		const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+(.*)$/.exec(line);
		if (assignment) {
			line = assignment[1] ?? "";
			continue;
		}
		const redirect = /^(?:\d?>>?|&>)\s*\S+\s+(.*)$/.exec(line);
		if (redirect) {
			line = redirect[1] ?? "";
			continue;
		}
		const segments = line.split(/(?:&&|\|\||;|\|)/);
		if (segments.length > 1) {
			const next = segments.find((segment) => segment.trim().length > 0 && !/^cd\s/.test(segment.trim()));
			if (next !== undefined) {
				line = next;
				continue;
			}
		}
		const words = line.split(/\s+/).filter((word) => word.length > 0);
		const head = words[0] ?? "";
		const program = normalizeProgram(head);
		if (WRAPPERS.has(program)) {
			const rest = words.slice(1).filter((word) => !word.startsWith("-"));
			const next = rest[0];
			if (next !== undefined) {
				line = rest.join(" ");
				continue;
			}
		}
		if (head.length === 0) break;
		if (SHELL_KEYWORDS.test(head)) return tool === "powershell" ? "pwsh" : "shell";
		if (/^[-0-9$"'(]/.test(head)) return tool === "powershell" ? "pwsh" : "shell";
		return program;
	}
	return tool === "powershell" ? "pwsh" : "shell";
}

function recordShape(command: string): { lineCount: number; heredoc: boolean } {
	const lines = command.split(/\r?\n/);
	return { lineCount: lines.length, heredoc: /<<-?\s*['"]?[A-Za-z_]/.test(command) };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (typeof block === "object" && block !== null && "text" in block ? String(block.text ?? "") : ""))
		.join("\n");
}

interface Outcome {
	status: CommandStatus;
	exitCode?: number;
	exitInferred: boolean;
	stderr: boolean;
	timedOut: boolean;
	denied: boolean;
}

/** Derive a status from the shell result envelope pi appends to the output. */
export function outcomeOfResult(text: string, isError: boolean): Outcome {
	const stderr = /\[stderr\]/.test(text);
	const timedOut = /timed out|timeout|OOM/i.test(text);
	const denied = /\[sandbox: file access denied/.test(text);
	const signal = /\[(?:shell )?killed by signal: (\w+)\]/i.exec(text);
	if (signal) return { status: "error", exitInferred: false, stderr, timedOut, denied };
	const code = /(?:Command exited with code|Command finished with exit code|shell exited: code) (\d+)/i.exec(text);
	if (code) {
		const exitCode = Number(code[1]);
		return { status: exitCode === 0 ? "ok" : "error", exitCode, exitInferred: false, stderr, timedOut, denied };
	}
	if (/Command terminated without an exit code|shell exited/i.test(text)) {
		return { status: "error", exitInferred: false, stderr, timedOut, denied };
	}
	if (isError || timedOut || denied)
		return { status: "error", exitCode: undefined, exitInferred: false, stderr, timedOut, denied };
	return { status: "ok", exitCode: 0, exitInferred: true, stderr, timedOut, denied };
}

/** Every shell and code execution, with the status the transcript implies. */
export function collectCommands(args: {
	entries: readonly SessionEntry[];
	steps?: ReadonlyArray<{ index: number; timestamp: number }>;
	mode?: "full" | "short";
}): CommandReport {
	const { entries, steps = [], mode = "full" } = args;
	const records: CommandRecord[] = [];
	const calls = new Map<string, { name: string; command: string; timestamp: number }>();
	const byId = new Map<string, CommandRecord>();

	const make = (
		id: string,
		tool: CommandRecord["tool"],
		name: string,
		command: string,
		timestamp: number,
		nested: boolean,
	): CommandRecord => {
		const origin = steps.length > 0 ? stepIndexOf(timestamp, steps) : 0;
		const record: CommandRecord = {
			id,
			tool,
			program: programOfCommand(name, command),
			command: mode === "short" ? "" : command,
			status: "missing",
			exitInferred: false,
			timestamp,
			durationEstimated: false,
			stepIndex: origin,
			nested,
			...recordShape(command),
			outputChars: 0,
			stderr: false,
			timedOut: false,
			denied: false,
		};
		records.push(record);
		byId.set(id, record);
		return record;
	};

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of (message.content ?? []) as Array<{
				type?: unknown;
				id?: unknown;
				name?: unknown;
				arguments?: unknown;
			}>) {
				if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
				const raw = (block.arguments as Record<string, unknown>) ?? {};
				const command = typeof raw.command === "string" ? raw.command : typeof raw.code === "string" ? raw.code : undefined;
				if (command === undefined) continue;
				const tool =
					block.name === "bash"
						? "bash"
						: block.name === "powershell"
							? "powershell"
							: block.name === "run_code"
								? "nested"
								: undefined;
				if (tool === undefined) continue;
				if (tool === "nested") {
					calls.set(block.id, { name: block.name, command, timestamp: message.timestamp });
					continue;
				}
				calls.set(block.id, { name: block.name, command, timestamp: message.timestamp });
				const record = make(block.id, tool, block.name, command, message.timestamp, false);
				record.program = programOfCommand(block.name, command);
			}
			continue;
		}

		if (message.role === "bashExecution") {
			const record = make(entry.id, "user-bash", "bash", message.command, message.timestamp, false);
			record.status = message.cancelled
				? "cancelled"
				: message.exitCode === 0
					? "ok"
					: message.exitCode === undefined
						? "missing"
						: "error";
			record.exitCode = message.exitCode;
			record.outputChars = message.output.length;
			continue;
		}

		if (message.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId);
		const record = byId.get(message.toolCallId);
		const text = textOf(message.content);
		if (record !== undefined) {
			const outcome = outcomeOfResult(text, message.isError);
			record.status = outcome.status;
			record.exitCode = outcome.exitCode;
			record.exitInferred = outcome.exitInferred;
			record.stderr = outcome.stderr;
			record.timedOut = outcome.timedOut;
			record.denied = outcome.denied;
			record.outputChars = text.length;
			record.timestamp = message.timestamp;
			if (typeof message.durationMs === "number") record.durationMs = message.durationMs;
			else if (call !== undefined) {
				record.durationMs = Math.max(0, message.timestamp - call.timestamp);
				record.durationEstimated = true;
			}
		}

		for (const nested of message.nestedCalls?.calls ?? []) {
			if (nested.name !== "bash" && nested.name !== "powershell" && nested.name !== "run_code") continue;
			const raw = (nested.arguments ?? {}) as Record<string, unknown>;
			const command = typeof raw.command === "string" ? raw.command : typeof raw.code === "string" ? raw.code : undefined;
			if (command === undefined) continue;
			const nestedRecord = make(
				`${message.toolCallId}/${nested.id}`,
				"nested",
				nested.name,
				command,
				message.timestamp,
				true,
			);
			nestedRecord.status = nested.status === "ok" ? "ok" : nested.status === "error" ? "error" : "missing";
			nestedRecord.exitCode = nested.status === "ok" ? 0 : undefined;
			nestedRecord.exitInferred = nested.status !== "error";
			if (typeof nested.durationMs === "number") nestedRecord.durationMs = nested.durationMs;
		}
	}

	const programCounts = new Map<string, { runs: number; ids: Set<string> }>();
	const commandCounts = new Map<string, number>();
	let failed = 0;
	let totalMs = 0;
	let nestedCount = 0;
	for (const record of records) {
		const entry = programCounts.get(record.program) ?? { runs: 0, ids: new Set<string>() };
		entry.runs += 1;
		entry.ids.add(record.id);
		programCounts.set(record.program, entry);
		commandCounts.set(record.command, (commandCounts.get(record.command) ?? 0) + 1);
		if (record.status === "error" || record.status === "cancelled") failed += 1;
		if (record.nested) nestedCount += 1;
		if (record.status !== "missing" && typeof record.durationMs === "number") totalMs += record.durationMs;
	}

	const finished = records.filter((record) => record.status !== "missing" && record.status !== "unfinished");
	const slowest = finished
		.filter((record) => (record.durationMs ?? 0) >= 1000)
		.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0];
	const mostFailing = [...programCounts]
		.map(([name, _value]) => ({
			name,
			count: records.filter(
				(record) => record.program === name && (record.status === "error" || record.status === "cancelled"),
			).length,
		}))
		.sort((a, b) => b.count - a.count)[0];
	const mostRepeated = [...commandCounts]
		.filter(([, count]) => count >= 2)
		.map(([command, count]) => ({ command, count }))
		.sort((a, b) => b.count - a.count)[0];
	const longestOutput = [...records].sort((a, b) => b.outputChars - a.outputChars)[0];

	return {
		records,
		runs: records.length,
		failed,
		totalMs,
		nested: nestedCount,
		programs: [...programCounts]
			.map(([name, value]) => ({ name, runs: value.runs, records: value.ids.size }))
			.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)),
		notable: {
			...(slowest === undefined ? {} : { slowest }),
			...(mostFailing !== undefined && mostFailing.count > 0 ? { mostFailing } : {}),
			...(mostRepeated === undefined ? {} : { mostRepeated }),
			...(longestOutput === undefined ? {} : { longestOutput }),
		},
	};
}
