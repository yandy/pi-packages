import { getToolStoragePlan } from "./detect";
import { materializeToolStorageRoots } from "./materialize";

/** Materialize the current workspace's detected storage plan for a confined call. */
export function toolStorageRoots(workspaceRoot: string): string[] {
	return materializeToolStorageRoots(getToolStoragePlan(workspaceRoot));
}

/** List detected profiles without creating or modifying any storage directory. */
export function detectedToolStorageProfiles(workspaceRoot: string): readonly string[] {
	return getToolStoragePlan(workspaceRoot).profiles;
}
