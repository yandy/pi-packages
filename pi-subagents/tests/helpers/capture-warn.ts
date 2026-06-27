import { vi } from "vitest";

/**
 * Run `run` with `console.warn` stubbed out, returning the captured warning
 * messages (the first argument of each call, stringified).
 *
 * The stub is always restored, even if `run` throws — so assertions placed
 * inside `run` propagate without leaking the spy. Use it to assert on emitted
 * warnings (`expect(captureWarn(...)).toEqual([...])`) or simply to suppress
 * expected `console.warn` output (`captureWarn(() => { ... })`).
 */
export function captureWarn(run: () => void): string[] {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    run();
    return spy.mock.calls.map((call) => String(call[0]));
  } finally {
    spy.mockRestore();
  }
}
