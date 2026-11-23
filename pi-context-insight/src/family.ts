import type { Msg, UsageAggregate } from "./model";

export interface SubagentRecord {
	id: string;
	type: string;
	description: string;
	status: string;
	startedAt: number;
	completedAt?: number;
	result?: string;
	error?: string;
	toolUses?: number;
	modelName?: string;
	thinking?: string;
	outputFile?: string;
}

export interface ChildSession {
	id: string;
	parentId?: string;
	brief?: string;
	steps: number;
	usage?: UsageAggregate;
	context?: { tokens: number | null; window: number; percent: number | null };
	durationMs?: number;
	records: SubagentRecord[];
}

export type FamilyStatus = "completed" | "error" | "stopped" | "aborted" | "untracked";

export interface FamilyMember {
	id: string;
	parentId: string | null;
	depth: number;
	status: FamilyStatus;
	record?: SubagentRecord;
	child?: ChildSession;
	brief?: string;
	context?: { tokens: number | null; window: number; percent: number | null };
	steps: number;
	durationMs?: number;
	usage?: UsageAggregate;
}

const STATUSES = new Set<FamilyStatus>(["completed", "error", "stopped", "aborted"]);
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_MEMBERS = 200;

function statusOf(record: SubagentRecord): FamilyStatus {
	return STATUSES.has(record.status as FamilyStatus) ? (record.status as FamilyStatus) : "untracked";
}

/**
 * Walk delegation records outward from this session, one level at a time. A child is only
 * accepted when its own header names the delegating session as its parent, so a copied or
 * stale transcript can never be charged to the wrong family.
 */
export function collectFamily(args: {
	parentSessionId: string;
	records: readonly SubagentRecord[];
	loadChild: (outputFile: string) => ChildSession | undefined;
	maxDepth?: number;
	maxMembers?: number;
}): { members: FamilyMember[]; warnings: Msg[] } {
	const { parentSessionId, records, loadChild } = args;
	const maxDepth = args.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxMembers = args.maxMembers ?? DEFAULT_MAX_MEMBERS;
	const members: FamilyMember[] = [];
	const warnings: Msg[] = [];
	const seen = new Set<string>([parentSessionId]);

	const queue: Array<{ parentId: string; depth: number; records: readonly SubagentRecord[] }> = [
		{ parentId: parentSessionId, depth: 0, records },
	];
	let depthTruncated = false;

	while (queue.length > 0) {
		const level = queue.shift();
		if (level === undefined) break;
		for (const record of level.records) {
			if (level.depth + 1 > maxDepth) {
				depthTruncated = true;
				continue;
			}
			if (record.outputFile === undefined) {
				warnings.push({ key: "warning.brokenChild", params: { id: record.id } });
				continue;
			}
			const child = loadChild(record.outputFile);
			if (child === undefined) {
				warnings.push({ key: "warning.brokenChild", params: { id: record.id } });
				continue;
			}
			if (child.parentId !== undefined && child.parentId !== level.parentId) {
				warnings.push({ key: "warning.lineageMismatch", params: { id: record.id } });
				continue;
			}
			if (seen.has(child.id)) continue;
			if (members.length >= maxMembers) {
				warnings.push({ key: "warning.memberLimit", params: { count: maxMembers } });
				queue.length = 0;
				break;
			}
			seen.add(child.id);
			members.push({
				id: child.id,
				parentId: level.parentId,
				depth: level.depth + 1,
				status: statusOf(record),
				record,
				child,
				...(child.brief === undefined ? {} : { brief: child.brief }),
				...(child.context === undefined ? {} : { context: child.context }),
				steps: child.steps,
				...(child.durationMs === undefined ? {} : { durationMs: child.durationMs }),
				...(child.usage === undefined ? {} : { usage: child.usage }),
			});
			if (child.records.length > 0) {
				queue.push({ parentId: child.id, depth: level.depth + 1, records: child.records });
			}
		}
	}

	if (depthTruncated) warnings.push({ key: "warning.depthLimit", params: { depth: maxDepth } });
	return { members, warnings };
}

/** The family sorted by depth then delegation time, which is the order the cards use. */
export function sortFamily(members: readonly FamilyMember[]): FamilyMember[] {
	return [...members].sort(
		(a, b) => a.depth - b.depth || (a.record?.startedAt ?? 0) - (b.record?.startedAt ?? 0) || a.id.localeCompare(b.id),
	);
}
