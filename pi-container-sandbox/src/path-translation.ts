import { resolve as resolvePath } from "node:path";
import { CONTAINER_ROOT } from "./paths";

/**
 * Tools the sandbox routes into the container itself. Their inputs are already
 * translated (hostToContainer) by the tool ops, so they must NOT be rewritten here.
 */
export const SANDBOX_ROUTED_TOOLS: ReadonlySet<string> = new Set(["bash", "read", "write", "edit"]);

/**
 * Maps a `/workspace` container path back to the host path it points to:
 *   /workspace     → hostCwd
 *   /workspace/a/b → hostCwd/a/b
 *   anything else  → unchanged (relative paths, host absolute paths, free text, /skills, user mounts)
 */
export function workspacePathToHost(path: string, hostCwd: string): string {
	if (path === CONTAINER_ROOT) return hostCwd;
	if (path.startsWith(`${CONTAINER_ROOT}/`)) {
		return resolvePath(hostCwd, path.slice(CONTAINER_ROOT.length + 1));
	}
	return path;
}

/**
 * Recursively walks a tool input and rewrites, in place, any string value that is a
 * `/workspace` container path to its host equivalent. Non-object/non-array inputs are
 * left untouched (tool inputs are always objects, so a bare top-level string is not a
 * real case and is intentionally not translated).
 */
export function translateToolCallPaths(input: unknown, hostCwd: string): void {
	if (Array.isArray(input)) {
		for (let i = 0; i < input.length; i++) {
			const value = input[i];
			if (typeof value === "string") input[i] = workspacePathToHost(value, hostCwd);
			else translateToolCallPaths(value, hostCwd);
		}
		return;
	}
	if (input !== null && typeof input === "object") {
		for (const key of Object.keys(input as Record<string, unknown>)) {
			const value = (input as Record<string, unknown>)[key];
			if (typeof value === "string") {
				(input as Record<string, unknown>)[key] = workspacePathToHost(value, hostCwd);
			} else {
				translateToolCallPaths(value, hostCwd);
			}
		}
	}
}

export interface ToolCallEventLike {
	toolName: string;
	input: unknown;
}

/**
 * Entry point used by the `tool_call` handler: translate a host-running tool's input,
 * skipping tools the sandbox routes into the container itself.
 */
export function translateHostToolCall(event: ToolCallEventLike, hostCwd: string): void {
	if (SANDBOX_ROUTED_TOOLS.has(event.toolName)) return;
	translateToolCallPaths(event.input, hostCwd);
}
