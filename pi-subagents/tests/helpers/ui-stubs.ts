import { vi } from "vitest";

/**
 * MenuUI stub with sequential select responses.
 *
 * Returns the flat UI shape (select, input, confirm, editor, notify, custom).
 * Callers that need to wrap this in a larger context object do so locally in their own test file.
 *
 * Return type unannotated so vi.fn() stubs retain their Mock<...> methods.
 */
export function makeMenuUI(selectResults: (string | undefined)[] = []) {
	let selectIdx = 0;
	return {
		select: vi.fn().mockImplementation(() => selectResults[selectIdx++]),
		input: vi.fn(),
		confirm: vi.fn(),
		editor: vi.fn(),
		notify: vi.fn(),
		custom: vi.fn(),
	};
}
