import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types";
import {
	GetResultTool,
	type GetResultToolManager,
	type GetResultToolNotifications,
} from "../../src/tools/get-result-tool";
import type { Subagent } from "../../src/types";
import { createTestSubagent, makeStubExecution } from "../helpers/make-subagent";
import { createSubagentSessionStub, toSubagentSession } from "../helpers/mock-session";
import { STUB_CTX } from "../helpers/stub-ctx";

const testRegistry = new AgentTypeRegistry(() => new Map());

function makeManager(records: Map<string, Subagent> = new Map()): GetResultToolManager {
	return { getRecord: (id: string) => records.get(id) };
}

function makeNotifications() {
	return { cancelNudge: vi.fn() };
}

async function execute(
	manager: GetResultToolManager,
	notifications: GetResultToolNotifications,
	params: { agent_id: string; wait?: boolean; verbose?: boolean },
) {
	const tool = new GetResultTool(manager, notifications, testRegistry);
	return tool.execute("tc-1", params, new AbortController().signal, undefined, STUB_CTX);
}

describe("GetResultTool", () => {
	it("returns tool definition with correct name", () => {
		const tool = new GetResultTool(makeManager(), makeNotifications(), testRegistry);
		expect(tool.toToolDefinition().name).toBe("get_subagent_result");
	});

	it("includes promptSnippet", () => {
		const tool = new GetResultTool(makeManager(), makeNotifications(), testRegistry);
		expect(tool.toToolDefinition().promptSnippet).toBe(
			"get_subagent_result: Check status and retrieve results from a background agent.",
		);
	});

	it("returns not-found message for unknown agent ID", async () => {
		const result = await execute(makeManager(), makeNotifications(), { agent_id: "unknown" });
		expect(result.content[0].text).toContain("Agent not found");
	});

	it("returns status and result for completed agent", async () => {
		const records = new Map([["agent-1", createTestSubagent()]]);
		const result = await execute(makeManager(records), makeNotifications(), { agent_id: "agent-1" });
		const text = result.content[0].text;
		expect(text).toContain("Agent: agent-1");
		expect(text).toContain("completed");
		expect(text).toContain("All done.");
	});

	it("shows running message for in-progress agent", async () => {
		const records = new Map([["agent-1", createTestSubagent({ status: "running", completedAt: undefined })]]);
		const result = await execute(makeManager(records), makeNotifications(), { agent_id: "agent-1" });
		expect(result.content[0].text).toContain("still running");
	});

	it("shows error for failed agent", async () => {
		const records = new Map([["agent-1", createTestSubagent({ status: "error", error: "timeout" })]]);
		const result = await execute(makeManager(records), makeNotifications(), { agent_id: "agent-1" });
		expect(result.content[0].text).toContain("Error: timeout");
	});

	it("marks notification consumed and cancels nudge for completed agent", async () => {
		const record = createTestSubagent({ toolCallId: "tc-1" });
		const records = new Map([["agent-1", record]]);
		const notifications = makeNotifications();
		await execute(makeManager(records), notifications, { agent_id: "agent-1" });
		expect(record.notification?.resultConsumed).toBe(true);
		expect(notifications.cancelNudge).toHaveBeenCalledWith("agent-1");
	});

	it("still cancels nudge for completed agent without NotificationState", async () => {
		const record = createTestSubagent();
		const records = new Map([["agent-1", record]]);
		const notifications = makeNotifications();
		await execute(makeManager(records), notifications, { agent_id: "agent-1" });
		expect(notifications.cancelNudge).toHaveBeenCalledWith("agent-1");
	});

	it("does not cancel nudge for running agent", async () => {
		const record = createTestSubagent({ status: "running", completedAt: undefined });
		const records = new Map([["agent-1", record]]);
		const notifications = makeNotifications();
		await execute(makeManager(records), notifications, { agent_id: "agent-1" });
		expect(notifications.cancelNudge).not.toHaveBeenCalled();
	});

	it("waits for promise when wait=true and agent is running", async () => {
		const sessionStub = createSubagentSessionStub();
		sessionStub.runTurnLoop.mockResolvedValue({ responseText: "Finished after wait.", aborted: false, steered: false });
		const record = createTestSubagent({
			status: "running",
			completedAt: undefined,
			execution: makeStubExecution({
				createSubagentSession: async () => toSubagentSession(sessionStub),
			}),
		});
		record.start();
		const records = new Map([["agent-1", record]]);
		const result = await execute(makeManager(records), makeNotifications(), { agent_id: "agent-1", wait: true });
		// After waiting, the record is completed and result is shown
		expect(result.content[0].text).toContain("Finished after wait.");
	});

	it("calls notification.markConsumed() when record has a NotificationState", async () => {
		const record = createTestSubagent({ toolCallId: "tc-1" });
		const records = new Map([["agent-1", record]]);
		await execute(makeManager(records), makeNotifications(), { agent_id: "agent-1" });
		expect(record.notification?.resultConsumed).toBe(true);
	});

	it("includes conversation when verbose=true", async () => {
		const record = createTestSubagent();
		const stub = createSubagentSessionStub();
		stub.getConversation.mockReturnValue("[User]: hello");
		record.subagentSession = toSubagentSession(stub);
		const records = new Map([["agent-1", record]]);
		const result = await execute(makeManager(records), makeNotifications(), { agent_id: "agent-1", verbose: true });
		expect(result.content[0].text).toContain("--- Agent Conversation ---");
		expect(result.content[0].text).toContain("[User]: hello");
	});
});
