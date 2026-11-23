import { describe, expect, it } from "vitest";
import { collectCommands, programOfCommand } from "../src/activity/commands";
import { assistantEntry, resetEntryIds, toolCall, toolResultEntry, userEntry } from "./helpers/entries";

function run(command: string, result: { content: string; isError?: boolean; durationMs?: number } | undefined, name = "bash") {
	resetEntryIds();
	const entries = [
		userEntry("hi", 0),
		assistantEntry({ content: [toolCall("c1", name, { command })], timestamp: 10 }),
	];
	if (result !== undefined) {
		entries.push(
			toolResultEntry({
				toolCallId: "c1",
				toolName: name,
				content: result.content,
				isError: result.isError ?? false,
				durationMs: result.durationMs,
				timestamp: 1000,
			}),
		);
	}
	return collectCommands({ entries }).records[0];
}

describe("programOfCommand", () => {
	it("normalizes common command shapes", () => {
		expect(programOfCommand("bash", "ls -la")).toBe("ls");
		expect(programOfCommand("bash", "cd src && npm test")).toBe("npm");
		expect(programOfCommand("bash", "FOO=1 BAR=2 node x.js")).toBe("node");
		expect(programOfCommand("bash", "env FOO=1 python -m pytest")).toBe("python");
		expect(programOfCommand("bash", "sudo /usr/bin/git status")).toBe("git");
		expect(programOfCommand("bash", "if [ -f x ]; then echo hi; fi")).toBe("shell");
		expect(programOfCommand("bash", "")).toBe("shell");
		expect(programOfCommand("powershell", "Get-ChildItem")).toBe("Get-ChildItem");
	});
});

describe("collectCommands", () => {
	it("marks a successful command and infers its exit code", () => {
		expect(run("ls", { content: "a\nb" })).toMatchObject({ status: "ok", exitCode: 0, exitInferred: true, program: "ls" });
	});
	it("parses an explicit exit code", () => {
		expect(run("ls", { content: "boom\nCommand exited with code 2", isError: true })).toMatchObject({ status: "error", exitCode: 2 });
	});
	it("marks a killed shell without an exit code", () => {
		expect(run("sleep 9", { content: "Command terminated without an exit code", isError: true })).toMatchObject({
			status: "error",
			exitCode: undefined,
		});
	});
	it("marks missing and unfinished runs", () => {
		expect(run("ls", undefined)).toMatchObject({ status: "missing" });
	});
	it("reads a user bash execution directly", () => {
		resetEntryIds();
		const entries = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: new Date(5).toISOString(),
				message: { role: "bashExecution", command: "!ls", output: "x", exitCode: 3, cancelled: false, truncated: false, timestamp: 5 },
			},
		] as never;
		const [record] = collectCommands({ entries }).records;
		expect(record).toMatchObject({ status: "error", exitCode: 3, tool: "user-bash" });
	});
	it("summarizes runs, failures, programs and notable entries", () => {
		resetEntryIds();
		const entries = [
			userEntry("hi", 0),
			assistantEntry({ content: [toolCall("c1", "bash", { command: "npm test" })], timestamp: 10 }),
			toolResultEntry({ toolCallId: "c1", toolName: "bash", content: "Command exited with code 1", isError: true, durationMs: 12_000, timestamp: 12_000 }),
			assistantEntry({ content: [toolCall("c2", "bash", { command: "npm run build" })], timestamp: 20_000 }),
			toolResultEntry({ toolCallId: "c2", toolName: "bash", content: "ok", durationMs: 800, timestamp: 21_000 }),
			assistantEntry({ content: [toolCall("c3", "bash", { command: "npm test" })], timestamp: 30_000 }),
			toolResultEntry({ toolCallId: "c3", toolName: "bash", content: "ok", durationMs: 5000, timestamp: 36_000 }),
		];
		const report = collectCommands({ entries });
		expect(report.runs).toBe(3);
		expect(report.failed).toBe(1);
		expect(report.programs.find((program) => program.name === "npm")?.runs).toBe(3);
		expect(report.notable.slowest?.command).toBe("npm test");
		expect(report.notable.mostRepeated?.command).toBe("npm test");
		expect(report.notable.mostFailing?.name).toBe("npm");
	});
});
