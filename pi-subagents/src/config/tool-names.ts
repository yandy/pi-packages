/**
 * tool-names.ts — Tool-set resolution for a child session.
 *
 * `tools` in frontmatter has four spellings (see the design doc): unset inherits
 * the parent session's active set, `none`/empty grants nothing, a plain list is an
 * exact allowlist, and a list of only `+name`/`-name` entries starts from the
 * inherited set. Everything here is pure; the caller supplies the parent's names.
 */

/** Tools registered by this package that a child must never be granted. */
export const DISPATCH_TOOL_NAMES: readonly string[] = ["subagent", "get_subagent_result", "steer_subagent"];

/** A `+name` / `-name` entry modifies the inherited set instead of naming a tool. */
function isModifierEntry(entry: string): boolean {
	return entry.startsWith("+") || entry.startsWith("-");
}

/**
 * Validate a `tools` list before it is resolved.
 *
 * A list made only of `+name` / `-name` entries is an inheriting list; mixing
 * those with plain names is invalid, and every entry must be an exact tool name.
 * The SDK rejects both cases too, but it cannot say which agent type is at
 * fault — check here so the error names the type.
 */
export function validateToolList(type: string, names: string[] | undefined): void {
	if (!names || names.length === 0) return;

	const modifierCount = names.filter(isModifierEntry).length;
	if (modifierCount > 0 && modifierCount < names.length) {
		throw new Error(
			`Agent "${type}" has an invalid "tools" list: plain tool names cannot be mixed with +name/-name entries (got: ${names.join(", ")}).`,
		);
	}

	const pattern = names.find((entry) => entry.includes("*"));
	if (pattern) {
		throw new Error(
			`Agent "${type}" has an invalid "tools" entry "${pattern}": patterns are not supported; list exact tool names.`,
		);
	}
}

/** Apply `+name` / `-name` entries to `base` left to right, mirroring the host. */
function applyModifiers(base: string[], entries: string[]): string[] {
	const result = [...base];
	for (const entry of entries) {
		const name = entry.slice(1);
		const index = result.indexOf(name);
		if (entry.startsWith("-")) {
			if (index !== -1) result.splice(index, 1);
		} else if (index === -1) {
			result.push(name);
		}
	}
	return result;
}

/** Remove duplicates, keeping the first occurrence. */
function dedupe(names: string[]): string[] {
	return [...new Set(names)];
}

/** Remove this package's dispatch tools, which a child must never be granted. */
function stripDispatch(names: string[]): string[] {
	return names.filter((name) => !DISPATCH_TOOL_NAMES.includes(name));
}

/**
 * Resolve the tool names a child session should be created with.
 *
 * `undefined` means "inherit whatever the parent session has bound" (the caller
 * strips dispatch tools after binding), `[]` means no tools at all, a plain list
 * is an exact allowlist, and a modifiers-only list is applied to the parent's set.
 */
export function resolveToolNames(
	type: string,
	configured: string[] | undefined,
	parentActive: string[] | undefined,
): string[] | undefined {
	validateToolList(type, configured);

	if (configured === undefined) {
		return parentActive === undefined ? undefined : stripDispatch(dedupe(parentActive));
	}
	if (configured.length === 0) return [];
	if (configured.every(isModifierEntry)) {
		return parentActive === undefined ? [...configured] : stripDispatch(dedupe(applyModifiers(parentActive, configured)));
	}
	return stripDispatch(dedupe(configured));
}
