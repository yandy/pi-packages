import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { MountSpec } from "./runtime";

export const REMOTE_ROOT = "/workspace";
export const SKILLS_ROOT = "/skills";

export function toContainerPath(
	hostPath: string,
	hostCwd: string,
	mounts: MountSpec[],
): { ok: true; path: string } | { ok: false; reason: string } {
	if (hostPath.startsWith(`${REMOTE_ROOT}/`) || hostPath === REMOTE_ROOT) {
		return { ok: true, path: hostPath };
	}
	if (hostPath.startsWith(`${SKILLS_ROOT}/`) || hostPath === SKILLS_ROOT) {
		return { ok: true, path: hostPath };
	}

	const abs = resolvePath(hostCwd, hostPath);

	if (abs === hostCwd || abs.startsWith(`${hostCwd}/`)) {
		const rel = abs === hostCwd ? "" : abs.slice(hostCwd.length + 1);
		return { ok: true, path: rel ? `${REMOTE_ROOT}/${rel}` : REMOTE_ROOT };
	}

	for (const m of mounts) {
		if (abs === m.source || abs.startsWith(`${m.source}/`)) {
			const rel = abs === m.source ? "" : abs.slice(m.source.length + 1);
			return { ok: true, path: rel ? `${m.target}/${rel}` : m.target };
		}
	}

	return { ok: false, reason: `Path escapes sandbox: ${hostPath}` };
}

export function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function resolveExtraMountPath(containerPath: string, mounts: MountSpec[]): string | null {
	for (const m of mounts) {
		if (containerPath === m.target || containerPath.startsWith(`${m.target}/`)) {
			return containerPath;
		}
	}
	return null;
}

export function hostToRemote(hostPath: string, hostCwd: string, mounts?: MountSpec[]): string {
	if (hostPath === REMOTE_ROOT || hostPath.startsWith(`${REMOTE_ROOT}/`)) {
		return hostPath;
	}
	if (mounts) {
		const resolved = resolveExtraMountPath(hostPath, mounts);
		if (resolved) return resolved;
	}
	const abs = resolvePath(hostCwd, hostPath);
	if (abs !== hostCwd && !abs.startsWith(`${hostCwd}/`)) {
		throw new Error(`sandbox: refusing to access ${abs}: outside of project cwd ${hostCwd}`);
	}
	const rel = abs === hostCwd ? "" : abs.slice(hostCwd.length + 1);
	return rel ? `${REMOTE_ROOT}/${rel}` : REMOTE_ROOT;
}

export function remoteToHost(containerPath: string, hostCwd: string, mounts: MountSpec[]): string {
	if (!containerPath.startsWith(REMOTE_ROOT) && !containerPath.startsWith(SKILLS_ROOT)) {
		return containerPath;
	}
	if (containerPath === REMOTE_ROOT) return hostCwd;
	if (containerPath.startsWith(`${REMOTE_ROOT}/`)) {
		return resolvePath(hostCwd, containerPath.slice(REMOTE_ROOT.length + 1));
	}
	for (const m of mounts) {
		if (containerPath === m.target) return m.source;
		if (containerPath.startsWith(`${m.target}/`)) {
			return resolvePath(m.source, containerPath.slice(m.target.length + 1));
		}
	}
	throw new Error(`Cannot map container path to host: ${containerPath}`);
}

export function isReadOnlyMount(containerPath: string, mounts: MountSpec[]): boolean {
	for (const m of mounts) {
		if (containerPath === m.target || containerPath.startsWith(`${m.target}/`)) {
			return true;
		}
	}
	return false;
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

export function isInsideCwd(hostPath: string, hostCwd: string): boolean {
	if (hostPath === REMOTE_ROOT || hostPath.startsWith(`${REMOTE_ROOT}/`)) return true;
	const abs = resolvePath(hostCwd, hostPath);
	return abs === hostCwd || abs.startsWith(`${hostCwd}/`);
}

export function getExternalPath(hostPath: string, hostCwd: string, mounts: MountSpec[]): string | null {
	if (isInsideCwd(hostPath, hostCwd)) return null;
	const abs = resolvePath(hostCwd, hostPath);
	const containerPath = hostPath.startsWith("/") ? hostPath : abs;
	if (resolveExtraMountPath(containerPath, mounts)) return null;
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

export async function requestPathApproval(
	absPath: string,
	sessionPrefixes: string[],
	store: PathApprovalStore,
	ui: {
		select: (title: string, options: string[]) => Promise<string | undefined>;
		notify: (msg: string, level?: "info" | "warning" | "error") => void;
	},
): Promise<boolean> {
	for (const prefix of sessionPrefixes) {
		if (absPath === prefix || absPath.startsWith(`${prefix}/`)) return true;
	}

	const existing = store.find(absPath);
	if (existing) return true;

	const basename = absPath.split("/").pop() || "";
	if (basename.startsWith("pi-clipboard-")) return true;

	const options = ["Approve once", "Approve always", "Approve for 7 days", "Approve for 30 days", "Deny"];

	let choice: string | undefined;
	try {
		choice = await ui.select(
			`Sandbox: 允许读取外部文件?
${absPath}`,
			options,
		);
	} catch {
		return false;
	}

	if (!choice || choice.includes("Deny")) return false;

	if (choice.includes("once")) {
		sessionPrefixes.push(absPath);
		return true;
	}

	if (choice.includes("always")) {
		store.add(absPath, Infinity);
		sessionPrefixes.push(absPath);
		ui.notify(`Approved read access (always): ${absPath}`, "info");
		return true;
	}

	const days = choice.includes("30") ? 30 : 7;
	store.add(absPath, days);
	sessionPrefixes.push(absPath);
	ui.notify(`Approved read access (${days} days): ${absPath}`, "info");
	return true;
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
	const approved = await requestPathApproval(absPath, sessionPrefixes, store, ui);
	if (!approved) {
		throw new Error(`sandbox: access denied to ${absPath}`);
	}
}
