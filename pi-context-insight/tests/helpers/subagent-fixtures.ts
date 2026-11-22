import { basename, dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export function createParent(root: string, parentSession?: string): SessionManager {
	const parent = SessionManager.create(root, join(root, "sessions"), { parentSession });
	parent.appendMessage({ role: "user", content: "parent task", timestamp: 1 });
	return parent;
}

export function tasksDir(parentFile: string): string {
	return join(dirname(parentFile), basename(parentFile, ".jsonl"), "tasks");
}

export function createChild(
	parent: SessionManager,
	options: { parentSession?: string; activeAgent?: string; tasksDirectory?: string } = {},
): SessionManager {
	const directory = options.tasksDirectory ?? tasksDir(parent.getSessionFile()!);
	const child = SessionManager.create(parent.getCwd(), directory, {
		parentSession: options.parentSession ?? parent.getSessionId(),
	});
	if (options.activeAgent) {
		child.appendMessage({ role: "system", content: `<active_agent name="${options.activeAgent}"/>`, timestamp: 1 });
	}
	child.appendMessage({ role: "user", content: "child task", timestamp: 2 });
	return child;
}

export function addRecord(
	parent: SessionManager,
	data: {
		id: string;
		outputFile?: string;
		type?: string;
		description?: string;
		status?: string;
		startedAt?: number;
		completedAt?: number;
	},
): void {
	parent.appendCustomEntry("subagents:record", {
		type: "general-purpose",
		description: "Inspect child",
		status: "completed",
		startedAt: 1,
		completedAt: 2,
		...data,
	});
}
