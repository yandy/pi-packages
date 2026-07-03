import type { SbxConfig } from "./config";
import type { MountSpec, Runtime, SandboxOptions } from "./runtime";

export interface SbxSession {
	runtime: Runtime;
	name: string;
	hostCwd: string;
	keep: boolean;
	/** Skill mounts auto-discovered from system prompt <available_skills> XML. Always /skills/<name>, ro. */
	skillMounts: MountSpec[];
	/** User-defined mounts from sandbox.json runtime.mounts. */
	userMounts: MountSpec[];
	/** Raw parseAvailableSkills result. Used by before_agent_start to fix <location> paths. */
	skillFileMapping: Array<{ name: string; hostFilePath: string }>;
	allowedExternalPrefixes: string[];
	resources?: SandboxOptions["resources"];
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
