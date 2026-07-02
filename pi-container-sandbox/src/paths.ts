import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type { MountSpec } from "./runtime";

export const CONTAINER_ROOT = "/workspace";
export const SKILLS_ROOT = "/skills";

export function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function findMount(containerPath: string, mounts: MountSpec[]): MountSpec | undefined {
	for (const m of mounts) {
		if (containerPath === m.target || containerPath.startsWith(`${m.target}/`)) {
			return m;
		}
	}
	return undefined;
}

export function isContainerPath(path: string): boolean {
	return path === CONTAINER_ROOT || path.startsWith(`${CONTAINER_ROOT}/`) ||
		path === SKILLS_ROOT || path.startsWith(`${SKILLS_ROOT}/`);
}

export function hostToContainer(hostPath: string, hostCwd: string, mounts?: MountSpec[]): string {
	if (isContainerPath(hostPath)) {
		return hostPath;
	}
	if (mounts) {
		const mount = findMount(hostPath, mounts);
		if (mount) return hostPath;
	}
	const abs = resolvePath(hostCwd, hostPath);
	if (abs !== hostCwd && !abs.startsWith(`${hostCwd}/`)) {
		throw new Error(`sandbox: refusing to access ${abs}: outside of project cwd ${hostCwd}`);
	}
	const rel = abs === hostCwd ? "" : abs.slice(hostCwd.length + 1);
	return rel ? `${CONTAINER_ROOT}/${rel}` : CONTAINER_ROOT;
}

export function containerToHost(containerPath: string, hostCwd: string, mounts: MountSpec[]): string {
	if (!isContainerPath(containerPath)) {
		return containerPath;
	}
	if (containerPath === CONTAINER_ROOT) return hostCwd;
	if (containerPath.startsWith(`${CONTAINER_ROOT}/`)) {
		return resolvePath(hostCwd, containerPath.slice(CONTAINER_ROOT.length + 1));
	}
	const mount = findMount(containerPath, mounts);
	if (mount) {
		return resolvePath(mount.source, containerPath.slice(mount.target.length + 1));
	}
	throw new Error(`Cannot map container path to host: ${containerPath}`);
}

export function isReadOnlyMount(containerPath: string, mounts: MountSpec[]): boolean {
	const mount = findMount(containerPath, mounts);
	if (!mount) return false;
	return mount.mode !== "rw";
}

export function isAllowedExternalResource(hostPath: string, allowedPrefixes: string[]): boolean {
	const abs = resolvePath(hostPath);
	const basename = abs.split("/").pop() || "";
	if (basename.startsWith("pi-clipboard-")) return true;
	for (const prefix of allowedPrefixes) {
		if (abs === prefix || abs.startsWith(`${prefix}/`)) return true;
	}
	return false;
}

export function isInsideContainer(hostPath: string, hostCwd: string): boolean {
	if (isContainerPath(hostPath)) return true;
	const abs = resolvePath(hostCwd, hostPath);
	return abs === hostCwd || abs.startsWith(`${hostCwd}/`);
}

export function getExternalPath(hostPath: string, hostCwd: string, mounts: MountSpec[]): string | null {
	if (isInsideContainer(hostPath, hostCwd)) return null;
	const abs = resolvePath(hostCwd, hostPath);
	const containerPath = hostPath.startsWith("/") ? hostPath : abs;
	if (findMount(containerPath, mounts)) return null;
	return abs;
}

interface PathApprovalRecord {
	path: string;
	approvedAt: number;
	expiresAt: number;
}

export class PathApprovalStore {
	private path: string;
	private records: Map<string, PathApprovalRecord> = new Map();
	private lastSaveTime: number = 0;

	constructor(hostCwd: string) {
		this.path = resolvePath(hostCwd, ".pi", "agent", "path-approvals.json");
		this.load();
	}

	private save(): void {
		const dir = this.path.slice(0, this.path.lastIndexOf("/"));
		if (!existsSync(dir)) {
			try {
				mkdirSync(dir, { recursive: true });
			} catch {
				return;
			}
		}

		let existing: Map<string, PathApprovalRecord> | null = null;
		try {
			if (existsSync(this.path)) {
				const raw = JSON.parse(readFileSync(this.path, "utf-8")) as (Omit<PathApprovalRecord, "expiresAt"> & {
					expiresAt: number | null;
				})[];
				existing = new Map();
				const now = Date.now();
				for (const r of raw) {
					const expiresAt = r.expiresAt === null ? Infinity : r.expiresAt;
					if (expiresAt === Infinity || expiresAt > now) {
						existing.set(r.path, { ...r, expiresAt });
					}
				}
			}
		} catch {
			// corrupt — skip merge
		}

		if (existing && existing.size > 0) {
			for (const [p, rec] of existing) {
				const ours = this.records.get(p);
				if (!ours) {
					if (rec.approvedAt > this.lastSaveTime) {
						this.records.set(p, rec);
					}
				} else if (rec.expiresAt > ours.expiresAt) {
					this.records.set(p, rec);
				}
			}
		}

		const tmpPath = `${this.path}.tmp`;
		const data = Array.from(this.records.values()).map((r) => ({
			...r,
			expiresAt: r.expiresAt === Infinity ? null : r.expiresAt,
		}));
		writeFileSync(tmpPath, JSON.stringify(data, null, 2));
		renameSync(tmpPath, this.path);
		this.lastSaveTime = Date.now();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf-8")) as (Omit<PathApprovalRecord, "expiresAt"> & {
				expiresAt: number | null;
			})[];
			const now = Date.now();
			for (const r of raw) {
				const expiresAt = r.expiresAt === null ? Infinity : r.expiresAt;
				if (expiresAt === Infinity || expiresAt > now) {
					this.records.set(r.path, { ...r, expiresAt });
				}
			}
		} catch {
			// corrupt file - start fresh
		}
		this.lastSaveTime = Date.now();
	}

	find(absPath: string): PathApprovalRecord | undefined {
		const exact = this.records.get(absPath);
		if (exact && (exact.expiresAt === Infinity || exact.expiresAt > Date.now())) return exact;

		for (const [, record] of this.records) {
			if (
				(absPath === record.path || absPath.startsWith(`${record.path}/`)) &&
				(record.expiresAt === Infinity || record.expiresAt > Date.now())
			) {
				return record;
			}
		}

		return undefined;
	}

	add(absPath: string, days: number | typeof Infinity): void {
		const now = Date.now();
		const record: PathApprovalRecord = {
			path: absPath,
			approvedAt: now,
			expiresAt: days === Infinity ? Infinity : now + days * 24 * 60 * 60 * 1000,
		};
		this.records.set(absPath, record);
		this.save();
	}

	revoke(absPath: string): boolean {
		if (this.records.delete(absPath)) {
			this.save();
			return true;
		}
		return false;
	}

	list(): PathApprovalRecord[] {
		return Array.from(this.records.values()).filter((r) => r.expiresAt === Infinity || r.expiresAt > Date.now());
	}
}

export async function ensureExternalReadApproved(
	absPath: string,
	sessionPrefixes: string[],
	store: PathApprovalStore,
	ui: {
		select: (title: string, options: string[]) => Promise<string | undefined>;
		notify: (msg: string, level?: "info" | "warning" | "error") => void;
	},
): Promise<void> {
	for (const prefix of sessionPrefixes) {
		if (absPath === prefix || absPath.startsWith(`${prefix}/`)) return;
	}

	const existing = store.find(absPath);
	if (existing) return;

	const basename = absPath.split("/").pop() || "";
	if (basename.startsWith("pi-clipboard-")) return;

	const options = ["Approve once", "Approve always", "Approve for 7 days", "Approve for 30 days", "Deny"];

	let choice: string | undefined;
	try {
		choice = await ui.select(
			`Sandbox: 允许读取外部文件?
${absPath}`,
			options,
		);
	} catch {
		throw new Error(`sandbox: access denied to ${absPath}`);
	}

	if (!choice || choice.includes("Deny")) {
		throw new Error(`sandbox: access denied to ${absPath}`);
	}

	if (choice.includes("once")) {
		sessionPrefixes.push(absPath);
		return;
	}

	if (choice.includes("always")) {
		store.add(absPath, Infinity);
		sessionPrefixes.push(absPath);
		ui.notify(`Approved read access (always): ${absPath}`, "info");
		return;
	}

	const days = choice.includes("30") ? 30 : 7;
	store.add(absPath, days);
	sessionPrefixes.push(absPath);
	ui.notify(`Approved read access (${days} days): ${absPath}`, "info");
}

export function expandPath(raw: string, cwd?: string): string {
	const home = homedir();
	let result = raw;
	if (result === '~' || result.startsWith('~/')) {
		result = home + result.slice(1);
	}
	if (cwd && !result.startsWith('/')) {
		result = resolvePath(cwd, result);
	}
	return result;
}
