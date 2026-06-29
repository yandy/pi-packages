import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MountSpec } from "./runtime";

export function discoverSkillMounts(): MountSpec[] {
	const home = homedir();
	const agentDir = getAgentDir();
	const skillRoots = [
		resolvePath(home, ".agents", "skills"),
		resolvePath(agentDir, "skills"),
	];

	const mounts: MountSpec[] = [];

	for (const root of skillRoots) {
		if (!existsSync(root)) continue;
		try {
			const entries = readdirSync(root);
			for (const entry of entries) {
				const full = resolvePath(root, entry);
				try {
					const st = statSync(full);
					if (!st.isDirectory()) continue;
				} catch {
					continue;
				}
				const target = `/skills/${entry}`;
				if (mounts.some((m) => m.target === target)) {
					console.debug(`sandbox: skipping duplicate mount target ${target} (already mounted from another source)`);
					continue;
				}
				mounts.push({ source: full, target, mode: 'ro' as const });
			}
		} catch {
			// Permission or I/O error - skip silently
		}
	}

	return mounts;
}
