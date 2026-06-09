import type { Runtime, MountSpec, RunArgs } from "./runtime";
import type { SbxConfig } from "./config";

export interface SbxSession {
	runtime: Runtime;
	name: string;
	hostCwd: string;
	keep: boolean;
	mounts: MountSpec[];
	allowedExternalPrefixes: string[];
	resources?: RunArgs["resources"];
	imageRef: string;
	config: SbxConfig;
	isReusable: boolean;
	isReattached: boolean;
}

let sandboxInstance: SbxSession | null = null;

export function getSbx(): SbxSession | null {
	return sandboxInstance;
}

export function setSbx(s: SbxSession): void {
	sandboxInstance = s;
}

export function clearSbx(): void {
	sandboxInstance = null;
}
