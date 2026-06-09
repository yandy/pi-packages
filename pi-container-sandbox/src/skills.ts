import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type { MountSpec } from "./runtime";

export function discoverSkillMounts(additionalPaths?: string[]): MountSpec[] {
	const home = homedir();
	const skillRoots = [
		...(additionalPaths ?? []),
		resolvePath(home, ".agents", "skills"),
		resolvePath(home, ".pi", "agent", "skills"),
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
				if (mounts.some((m) => m.target === target)) continue;
				mounts.push({ source: full, target });
			}
		} catch {
			// Permission or I/O error - skip silently
		}
	}

	return mounts;
}
