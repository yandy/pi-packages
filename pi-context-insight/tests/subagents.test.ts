import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSubagentSessions } from "../src/subagents";
import { addRecord, createChild, createParent, tasksDir } from "./helpers/subagent-fixtures";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-insight-subagents-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("subagent discovery", () => {
	it("deduplicates completion records and directory scans by realpath", () => {
		const parent = createParent(join(root, "parent"));
		const child = createChild(parent, { activeAgent: "Explore" });
		addRecord(parent, { id: "agent-1", outputFile: child.getSessionFile(), type: "recorded-type" });

		const result = loadSubagentSessions(parent);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].metadata).toMatchObject({ id: "agent-1", type: "recorded-type", status: "completed", filePath: child.getSessionFile() });
	});

	it("includes foreground and unrecorded children with honest fallback metadata", () => {
		const parent = createParent(join(root, "parent"));
		createChild(parent, { activeAgent: "Explore" });
		createChild(parent);

		const result = loadSubagentSessions(parent);
		expect(result.sessions).toHaveLength(2);
		expect(result.sessions.every((session) => session.metadata.status === "untracked")).toBe(true);
		expect(result.sessions.map((session) => session.metadata.type).sort()).toEqual(["Explore", "unknown"]);
		expect(result.sessions.every((session) => session.metadata.description.startsWith("Subagent "))).toBe(true);
	});

	it("loads an ancestor tasks file outside the current sessionDir through the header chain", () => {
		const original = createParent(join(root, "original"));
		const child = createChild(original);
		const originalFile = original.getSessionFile()!;
		const fork = createParent(join(root, "fork"), originalFile);
		addRecord(fork, { id: "agent-old", outputFile: child.getSessionFile() });

		expect(child.getSessionFile()!.startsWith(fork.getSessionDir())).toBe(false);
		const result = loadSubagentSessions(fork);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].metadata.id).toBe("agent-old");
		expect(result.sessions[0].metadata.filePath).toBe(child.getSessionFile());
	});

	it("rejects a matching path whose child header names another parent", () => {
		const parent = createParent(join(root, "parent"));
		createChild(parent, { parentSession: "some-other-parent" });
		const result = loadSubagentSessions(parent);
		expect(result.sessions).toEqual([]);
		expect(result.warnings.join("\n")).toContain("parentSession");
	});

	it("rejects traversal, non-JSONL and paths outside every lineage root", () => {
		const parent = createParent(join(root, "parent"));
		const tasks = tasksDir(parent.getSessionFile()!);
		addRecord(parent, { id: "traversal", outputFile: join(tasks, "..", "outside.jsonl") });
		addRecord(parent, { id: "text", outputFile: join(tasks, "notes.txt") });
		addRecord(parent, { id: "outside", outputFile: join(root, "outside.jsonl") });

		const result = loadSubagentSessions(parent);
		expect(result.sessions).toEqual([]);
		expect(result.warnings).toHaveLength(3);
	});

	(process.platform === "win32" ? it.skip : it)("rejects a symlink escaping an allowed root", () => {
		const parent = createParent(join(root, "parent"));
		const outside = createChild(parent, { tasksDirectory: join(root, "outside") });
		const link = join(tasksDir(parent.getSessionFile()!), "linked.jsonl");
		mkdirSync(tasksDir(parent.getSessionFile()!), { recursive: true });
		symlinkSync(outside.getSessionFile()!, link, "file");

		const result = loadSubagentSessions(parent);
		expect(result.sessions).toEqual([]);
		expect(result.warnings.join("\n")).toContain("linked.jsonl");
	});

	it("filters ephemeral children by the current parent identity", () => {
		const parent = SessionManager.inMemory(join(root, "ephemeral"));
		const tasks = join(root, "ephemeral-tasks");
		createChild(parent, { tasksDirectory: tasks });
		createChild(parent, { tasksDirectory: tasks, parentSession: "other-parent" });

		const result = loadSubagentSessions(parent, { ephemeralTasksDir: tasks });
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].manager.getHeader()?.parentSession).toBe(parent.getSessionId());
	});

	it("keeps valid siblings when records are missing, corrupt or malformed", () => {
		const parent = createParent(join(root, "parent"));
		const valid = createChild(parent);
		const tasks = tasksDir(parent.getSessionFile()!);
		const corrupt = join(tasks, "corrupt.jsonl");
		writeFileSync(corrupt, "not a session", "utf8");
		addRecord(parent, { id: "missing", outputFile: join(tasks, "missing.jsonl") });
		addRecord(parent, { id: "corrupt", outputFile: corrupt });
		parent.appendCustomEntry("subagents:record", null);

		const result = loadSubagentSessions(parent);
		expect(result.sessions.map((session) => session.metadata.filePath)).toEqual([valid.getSessionFile()]);
		expect(result.warnings.length).toBeGreaterThanOrEqual(3);
		expect(result.warnings.join("\n")).toContain("corrupt.jsonl");
	});

	it("supports the legacy record fallback only inside current tasks", () => {
		const parent = createParent(join(root, "parent"));
		const child = createChild(parent);
		const renamed = join(tasksDir(parent.getSessionFile()!), "agent-legacy.jsonl");
		renameSync(child.getSessionFile()!, renamed);
		addRecord(parent, { id: "agent-legacy" });

		const result = loadSubagentSessions(parent);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].metadata).toMatchObject({ id: "agent-legacy", filePath: renamed, status: "completed" });
		expect(basename(result.sessions[0].metadata.filePath)).toBe("agent-legacy.jsonl");
	});
});
