import { describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "../../src/lifecycle/concurrency-limiter";

/** A controllable task: a thunk plus its resolve handle, for gating completion. */
function makeTask() {
	const { promise, resolve } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
	const task = vi.fn(() => promise);
	return { task, resolve };
}

describe("ConcurrencyLimiter", () => {
	describe("slot gating", () => {
		it("runs a task immediately when a slot is free", () => {
			const limiter = new ConcurrencyLimiter(() => 2);
			const { task } = makeTask();
			void limiter.schedule(task);
			expect(task).toHaveBeenCalledOnce();
		});

		it("runs tasks up to the limit and holds the rest pending", () => {
			const limiter = new ConcurrencyLimiter(() => 2);
			const a = makeTask();
			const b = makeTask();
			const c = makeTask();

			void limiter.schedule(a.task);
			void limiter.schedule(b.task);
			void limiter.schedule(c.task);

			expect(a.task).toHaveBeenCalledOnce();
			expect(b.task).toHaveBeenCalledOnce();
			expect(c.task).not.toHaveBeenCalled();
		});

		it("starts the next pending task when an active task settles", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const a = makeTask();
			const c = makeTask();

			void limiter.schedule(a.task);
			void limiter.schedule(c.task);

			expect(a.task).toHaveBeenCalledOnce();
			expect(c.task).not.toHaveBeenCalled();

			a.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(c.task).toHaveBeenCalledOnce();
		});
	});

	describe("FIFO order", () => {
		it("starts pending tasks in scheduling order", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const order: string[] = [];
			const gates = [makeTask(), makeTask(), makeTask()] as const;
			const labels = ["first", "second", "third"];

			gates.forEach((gate, i) => {
				gate.task.mockImplementation(() => {
					order.push(labels[i]);
					const { promise, resolve } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
					gate.resolve = resolve;
					return promise;
				});
				void limiter.schedule(gate.task);
			});

			expect(order).toEqual(["first"]);

			gates[0].resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(order).toEqual(["first", "second"]);

			gates[1].resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(order).toEqual(["first", "second", "third"]);
		});
	});

	describe("schedule() promise settlement", () => {
		it("resolves the returned promise when the task resolves", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const { task, resolve } = makeTask();
			const scheduled = limiter.schedule(task);
			resolve();
			await expect(scheduled).resolves.toBeUndefined();
		});

		it("rejects the returned promise when the task rejects", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const { promise, reject } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
			const scheduled = limiter.schedule(() => promise);
			reject(new Error("boom"));
			await expect(scheduled).rejects.toThrow("boom");
		});

		it("frees the slot for the next task when a task rejects", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const { promise, reject } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
			const next = makeTask();

			const scheduled = limiter.schedule(() => promise);
			void limiter.schedule(next.task);
			expect(next.task).not.toHaveBeenCalled();

			reject(new Error("boom"));
			await scheduled.catch(() => {});
			await Promise.resolve();

			expect(next.task).toHaveBeenCalledOnce();
		});
	});

	describe("recheck()", () => {
		it("starts newly-admissible pending tasks when the limit grows", () => {
			let limit = 1;
			const limiter = new ConcurrencyLimiter(() => limit);
			const a = makeTask();
			const b = makeTask();

			void limiter.schedule(a.task);
			void limiter.schedule(b.task);
			expect(b.task).not.toHaveBeenCalled();

			limit = 2;
			limiter.recheck();
			expect(b.task).toHaveBeenCalledOnce();
		});

		it("does nothing when no slot is free", () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const a = makeTask();
			const b = makeTask();
			void limiter.schedule(a.task);
			void limiter.schedule(b.task);

			limiter.recheck();
			expect(b.task).not.toHaveBeenCalled();
		});

		it("re-evaluates the limit dynamically per call", () => {
			let limit = 2;
			const limiter = new ConcurrencyLimiter(() => limit);
			const a = makeTask();
			const b = makeTask();
			const c = makeTask();
			void limiter.schedule(a.task);
			void limiter.schedule(b.task);
			void limiter.schedule(c.task);
			expect(c.task).not.toHaveBeenCalled();

			// Lowering the limit below the active count starts nothing.
			limit = 1;
			limiter.recheck();
			expect(c.task).not.toHaveBeenCalled();
		});
	});

	describe("clear()", () => {
		it("drops pending tasks without running them", () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const a = makeTask();
			const pending = makeTask();
			void limiter.schedule(a.task);
			void limiter.schedule(pending.task);

			limiter.clear();
			a.resolve();

			expect(pending.task).not.toHaveBeenCalled();
		});

		it("resolves the promises of dropped pending tasks", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const a = makeTask();
			a.task.mockImplementation(() => new Promise<void>(() => {})); // never settles
			void limiter.schedule(a.task);
			const droppedPromise = limiter.schedule(makeTask().task);

			limiter.clear();

			await expect(droppedPromise).resolves.toBeUndefined();
		});

		it("does not disturb already-running tasks", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const a = makeTask();
			const scheduled = limiter.schedule(a.task);

			limiter.clear();
			a.resolve();

			await expect(scheduled).resolves.toBeUndefined();
		});
	});
});
