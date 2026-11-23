import { describe, expect, it, vi } from "vitest";
import { announceApproval } from "../src/notification";

describe("announceApproval", () => {
	it("emits one critical presentation request with the approval title as body", () => {
		const emit = vi.fn();
		announceApproval(emit, "Allow this command?");
		expect(emit).toHaveBeenCalledExactlyOnceWith("notify:request", {
			title: "Approval required",
			body: "Allow this command?",
			urgency: "critical",
		});
	});
});
