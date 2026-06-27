import { describe, expect, it, vi } from "vitest";
import { createBlockingFactory, createSessionFactory } from "./manager-stubs";
import { createMockSession } from "./mock-session";

describe("createBlockingFactory", () => {
	it("returns a pending promise (never resolves)", () => {
		const factory = createBlockingFactory();
		const p = factory({} as never);
		let settled = false;
		void p.then(() => {
			settled = true;
		});
		expect(settled).toBe(false);
	});

	it("is a vi.fn stub", () => {
		const factory = createBlockingFactory();
		expect(vi.isMockFunction(factory)).toBe(true);
	});
});

describe("createSessionFactory", () => {
	it("resolves to a SubagentSession stub wrapping the given session", async () => {
		const session = createMockSession();
		const { factory, stub } = createSessionFactory(session);
		const sub = await factory({} as never);
		expect(sub).toBe(stub);
		expect(stub.session).toBe(session);
	});

	it("exposes the outputFile on the stub", async () => {
		const { stub } = createSessionFactory(createMockSession(), "/tmp/out.jsonl");
		expect(stub.outputFile).toBe("/tmp/out.jsonl");
	});

	it("runTurnLoop resolves to a done TurnLoopResult by default", async () => {
		const { stub } = createSessionFactory();
		await expect(stub.runTurnLoop("go", {})).resolves.toEqual({
			responseText: "done",
			aborted: false,
			steered: false,
		});
	});

	it("the factory is a vi.fn stub", () => {
		const { factory } = createSessionFactory();
		expect(vi.isMockFunction(factory)).toBe(true);
	});
});
