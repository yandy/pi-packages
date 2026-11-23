import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CATEGORY_ORDER, type CategoryId, type Msg } from "../model";
import { extractItems, type Item } from "./categorize";
import { type ReplayedSystem, replaySystem } from "./replay";

export interface StepActual {
	prompt: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	costFromProvider: boolean;
}

export interface BriefChip {
	itemId: number;
	tag: string;
	preview: string;
}

export interface StepBrief {
	user?: BriefChip;
	inputs: BriefChip[];
	replies: BriefChip[];
}

export interface Step {
	index: number;
	turn: number;
	stepInTurn: number;
	timestamp: number;
	durationMs?: number;
	durationEstimated: boolean;
	activeMs: number;
	idleMs: number;
	sums: Record<CategoryId, number>;
	estimatedTotal: number;
	actual?: StepActual;
	costByCategory?: Partial<Record<CategoryId, number>>;
	delta: Partial<Record<CategoryId, number>>;
	deltaTotal: number;
	itemRanges: Array<[number, number]>;
	eventIds: number[];
	hasDetails: boolean;
	brief: StepBrief;
	system: ReplayedSystem | null;
}

export interface Turn {
	index: number;
	startStep: number;
	endStep: number;
	startTimestamp: number;
}

export interface BuildStepsResult {
	steps: Step[];
	items: Item[];
	bodies: string[];
	turns: Turn[];
	warnings: Msg[];
	finalEstimate: number;
	stepItemIds: number[][];
}

export const DETAIL_WINDOW_STEPS = 300;
const UNATTRIBUTED_MIN_SHARE = 0.02;
const PREVIEW_CHARS = 80;
const MAX_CHIPS = 3;

function emptySums(): Record<CategoryId, number> {
	const sums = {} as Record<CategoryId, number>;
	for (const id of CATEGORY_ORDER) sums[id] = 0;
	return sums;
}

function totalOf(sums: Record<CategoryId, number>): number {
	let total = 0;
	for (const id of CATEGORY_ORDER) {
		if (id === "unattributed") continue;
		total += sums[id] ?? 0;
	}
	return total;
}

function rangesOf(ids: readonly number[]): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const id of ids) {
		const last = ranges[ranges.length - 1];
		if (last && id === last[1] + 1) last[1] = id;
		else ranges.push([id, id]);
	}
	return ranges;
}

function isTurnStarter(entry: SessionEntry): boolean {
	if (entry.type === "branch_summary") return true;
	if (entry.type !== "message") return false;
	const role = entry.message.role;
	if (role === "user" || role === "custom" || role === "branchSummary") return true;
	return role === "bashExecution" && entry.message.excludeFromContext !== true;
}

function isUserTurnMessage(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	const role = entry.message.role;
	return role === "user" || role === "custom" || role === "bashExecution";
}

/**
 * Walk the branch once and rebuild, for every assistant message, the context the model saw
 * when it received that request. Item tokens are computed once; per-step category sums are
 * maintained incrementally, and a compaction rebuilds the retained subset in place.
 */
export function buildSteps(args: {
	branch: readonly SessionEntry[];
	mode: "full" | "short";
	putBody: (text: string) => number | null;
}): BuildStepsResult {
	const { branch, mode } = args;
	const items: Item[] = [];
	const bodies: string[] = [];
	const warnings: Msg[] = [];
	const steps: Step[] = [];
	const turns: Turn[] = [];

	let nextItemId = 0;
	const putBody = (text: string): number | null => {
		if (mode === "short") return null;
		bodies.push(text);
		return bodies.length - 1;
	};

	const order: SessionEntry[] = [];
	const itemsByEntry = new Map<string, Item[]>();
	const callArgs = new Map<string, Record<string, unknown>>();
	const snapshotIds: number[][] = [];
	let activeItems: Item[] = [];
	const activeIds = new Set<number>();
	let sums = emptySums();
	let system: ReplayedSystem | null = null;
	let turnIndex = 0;
	let stepInTurn = 0;
	let pendingTurnStartItem: BriefChip | undefined;
	let previousSums = emptySums();
	let previousIds = new Set<number>();

	const previewOf = (item: Item): string => {
		if (item.textIndex === null) return "";
		const text = bodies[item.textIndex] ?? "";
		const flat = text.replace(/\s+/g, " ").trim();
		return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
	};
	const chipOf = (item: Item): BriefChip => ({ itemId: item.id, tag: item.tag, preview: previewOf(item) });

	const extract = (entry: SessionEntry): Item[] => {
		const timestamp = Date.parse(entry.timestamp);
		const list = extractItems({
			entry,
			system,
			nextId: () => nextItemId++,
			putBody,
			callArgs: (id) => callArgs.get(id),
		});
		for (const item of list) if (Number.isFinite(timestamp)) item.timestamp = timestamp;
		return list;
	};

	const register = (list: readonly Item[]): void => {
		for (const item of list) items.push(item);
	};

	const addItems = (list: readonly Item[]): void => {
		for (const item of list) {
			activeItems.push(item);
			activeIds.add(item.id);
			sums[item.category] = (sums[item.category] ?? 0) + item.tokens;
		}
	};

	const dropItem = (item: Item): void => {
		sums[item.category] = (sums[item.category] ?? 0) - item.tokens;
		activeIds.delete(item.id);
		activeItems = activeItems.filter((candidate) => candidate !== item);
	};

	/**
	 * A later system message re-declares named sections and tool declarations. Anything the
	 * replay no longer reports must leave the context, or the step would keep charging for a
	 * section (or tool) the model can no longer see.
	 */
	const reconcileSystemItems = (): void => {
		const sectionNames = new Set(Object.keys(system?.sections ?? {}));
		const toolNames = new Set((system?.tools ?? []).map((tool) => tool.name));
		for (const item of [...activeItems]) {
			if (item.kind === "systemSection" && item.tag !== "base" && !sectionNames.has(item.tag)) dropItem(item);
			if (item.kind === "toolDefinition" && !toolNames.has(item.tag)) dropItem(item);
		}
	};

	for (const entry of branch) {
		if (entry.type === "compaction") {
			system = replaySystem([...order, entry]);
			const compactionItems = extract(entry);
			itemsByEntry.set(entry.id, compactionItems);
			register(compactionItems);
			const keptIndex = order.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
			const kept = keptIndex >= 0 ? order.slice(keptIndex) : [];
			activeItems = [...compactionItems];
			activeIds.clear();
			sums = emptySums();
			for (const item of compactionItems) {
				activeIds.add(item.id);
				sums[item.category] = item.tokens;
			}
			for (const keptEntry of kept) {
				// The host only lets the newest compaction contribute a summary, and drops the
				// system messages it re-declares from the retained range.
				if (keptEntry.type === "compaction") continue;
				if (keptEntry.type === "message" && keptEntry.message.role === "system") continue;
				for (const item of itemsByEntry.get(keptEntry.id) ?? []) {
					activeItems.push(item);
					activeIds.add(item.id);
					sums[item.category] = (sums[item.category] ?? 0) + item.tokens;
				}
			}
			order.push(entry);
			continue;
		}

		if (entry.type === "message" && entry.message.role === "system") {
			system = replaySystem([...order, entry]);
			const entryItems = extract(entry);
			itemsByEntry.set(entry.id, entryItems);
			// Replace earlier declarations of the same section or tool before adding the new one.
			for (const item of [...activeItems]) {
				if (item.entryId === entry.id) continue;
				if (item.kind !== "systemSection" && item.kind !== "toolDefinition") continue;
				if (entryItems.some((next) => next.tag === item.tag && next.kind === item.kind)) dropItem(item);
			}
			reconcileSystemItems();
			register(entryItems);
			addItems(entryItems);
			order.push(entry);
			continue;
		}

		if (entry.type === "context_edit") {
			const targetItems = itemsByEntry.get(entry.targetId) ?? [];
			const target = order.find((candidate) => candidate.id === entry.targetId);
			if (target) {
				for (const item of targetItems) dropItem(item);
				const replacementItems =
					entry.replacement === null
						? []
						: extract({
								...target,
								...(target.type === "message"
									? { message: { ...target.message, content: entry.replacement.content } as never }
									: {}),
							} as SessionEntry);
				itemsByEntry.set(entry.targetId, replacementItems);
				if (replacementItems.length > 0) {
					register(replacementItems);
					addItems(replacementItems);
				}
			}
			order.push(entry);
			continue;
		}

		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			const snapshot = { ...sums };
			const estimatedTotal = totalOf(snapshot);
			const usage = message.usage;
			const actual: StepActual | undefined =
				usage === undefined
					? undefined
					: {
							prompt: usage.input + usage.cacheRead + usage.cacheWrite,
							output: usage.output,
							cacheRead: usage.cacheRead,
							cacheWrite: usage.cacheWrite,
							cost: usage.cost.total,
							costFromProvider: usage.cost.totalFromProvider === true,
						};
			if (actual !== undefined) {
				const diff = actual.prompt - estimatedTotal;
				if (diff > 0 && diff > estimatedTotal * UNATTRIBUTED_MIN_SHARE) snapshot.unattributed = diff;
			}
			stepInTurn += 1;
			const inputs = activeItems
				.filter((item) => !previousIds.has(item.id))
				.slice(0, MAX_CHIPS)
				.map(chipOf);
			const delta: Partial<Record<CategoryId, number>> = {};
			for (const id of CATEGORY_ORDER) {
				const value = (snapshot[id] ?? 0) - (previousSums[id] ?? 0);
				if (value !== 0) delta[id] = value;
			}
			steps.push({
				index: steps.length,
				turn: Math.max(turnIndex, 1),
				stepInTurn,
				timestamp: message.timestamp,
				...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
				durationEstimated: message.durationMs === undefined,
				activeMs: message.durationMs ?? 0,
				idleMs: 0,
				sums: snapshot,
				estimatedTotal,
				...(actual === undefined ? {} : { actual }),
				delta,
				deltaTotal: Object.values(delta).reduce((sum, value) => sum + value, 0),
				itemRanges: [],
				eventIds: [],
				hasDetails: true,
				brief: {
					...(pendingTurnStartItem === undefined ? {} : { user: pendingTurnStartItem }),
					inputs,
					replies: [],
				},
				system,
			});
			snapshotIds.push([...activeIds]);

			for (const block of (message.content ?? []) as Array<{ type?: unknown; id?: unknown; arguments?: unknown }>) {
				if (block.type === "toolCall" && typeof block.id === "string") {
					callArgs.set(block.id, (block.arguments as Record<string, unknown>) ?? {});
				}
			}
			const entryItems = extract(entry);
			itemsByEntry.set(entry.id, entryItems);
			const step = steps[steps.length - 1];
			if (step) step.brief.replies = entryItems.slice(0, MAX_CHIPS).map(chipOf);
			register(entryItems);
			addItems(entryItems);
			// The next request starts counting from here: everything added until then is its input.
			previousSums = snapshot;
			previousIds = new Set(activeIds);
			order.push(entry);
			continue;
		}

		const entryItems = extract(entry);
		itemsByEntry.set(entry.id, entryItems);
		if (isTurnStarter(entry)) {
			turnIndex += 1;
			stepInTurn = 0;
			turns.push({
				index: turnIndex,
				startStep: steps.length,
				endStep: steps.length,
				startTimestamp: Date.parse(entry.timestamp),
			});
			const userItem = entryItems.find((item) => item.category === "user");
			if (userItem && isUserTurnMessage(entry)) pendingTurnStartItem = chipOf(userItem);
		}
		register(entryItems);
		addItems(entryItems);
		order.push(entry);
	}

	for (const turn of turns) {
		const next = turns.find((candidate) => candidate.index === turn.index + 1);
		turn.endStep = (next?.startStep ?? steps.length) - 1;
	}

	applyDetailWindow(steps, snapshotIds);

	return {
		steps,
		items,
		bodies,
		turns,
		warnings,
		finalEstimate: totalOf(sums),
		stepItemIds: snapshotIds,
	};
}

/** The step a timestamp belongs to: the last request that had already started. */
export function stepIndexOf(timestamp: number, steps: ReadonlyArray<{ index: number; timestamp: number }>): number {
	if (steps.length === 0) return 0;
	let found = steps[0]?.index ?? 0;
	for (const step of steps) {
		if (step.timestamp <= timestamp) found = step.index;
		else break;
	}
	return found;
}

/**
 * Decide which steps keep their detail. Steps carrying an event are always kept, so this
 * runs after events are placed; the rest of the report only reads the result.
 */
export function applyDetailWindow(steps: Step[], stepItemIds: readonly number[][]): void {
	const windowStart = Math.max(0, steps.length - DETAIL_WINDOW_STEPS);
	for (const step of steps) {
		step.hasDetails = step.index >= windowStart || step.eventIds.length > 0;
		step.itemRanges = step.hasDetails ? rangesOf(stepItemIds[step.index] ?? []) : [];
	}
}
