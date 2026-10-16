// Persistence for pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (agentDir injected at construction) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_TIERS, type ModelTierMap } from "./config/model-tiers";
import { type LayeredSettingsSource, loadLayeredSettings } from "./layered-settings";
export interface SubagentsSettings {
	maxConcurrent?: number;
	/**
	 * 0 = unlimited — the extension's single source of truth for that convention:
	 * `normalizeMaxTurns()` in turn-limits.ts treats 0 → `undefined`, and the
	 * `/agents` → Settings input prompt explicitly says "0 = unlimited".
	 */
	defaultMaxTurns?: number;
	graceTurns?: number;
	/**
	 * Capability/cost tier → real model mapping for the `subagent` tool's
	 * `model_tier` param. Tier names are fixed (`fast` | `standard` | `advanced`);
	 * values accept anything `resolveModel` understands (e.g. "provider/modelId"
	 * or a fuzzy name like "haiku").
	 */
	modelTiers?: ModelTierMap;
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_GRACE_TURNS = 5;

/**
 * Owns all three in-memory settings values and their load/save/persist cycle.
 * Replaces the scattered free-function + SettingsAppliers callback pattern.
 */
export class SettingsManager {
	private _defaultMaxTurns: number | undefined = undefined;
	private _graceTurns: number = DEFAULT_GRACE_TURNS;
	private _maxConcurrent: number = DEFAULT_MAX_CONCURRENT;
	private _modelTiers: ModelTierMap = {};

	private readonly emit: SettingsEmit;
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly onMaxConcurrentChanged: (() => void) | undefined;

	constructor(deps: { emit: SettingsEmit; cwd: string; agentDir: string; onMaxConcurrentChanged?: () => void }) {
		this.emit = deps.emit;
		this.cwd = deps.cwd;
		this.agentDir = deps.agentDir;
		this.onMaxConcurrentChanged = deps.onMaxConcurrentChanged;
	}

	// ── defaultMaxTurns: 0 or undefined → unlimited (undefined); else max(1, n) ──

	get defaultMaxTurns(): number | undefined {
		return this._defaultMaxTurns;
	}

	set defaultMaxTurns(n: number | undefined) {
		if (n == null || n === 0) {
			this._defaultMaxTurns = undefined;
		} else {
			this._defaultMaxTurns = Math.max(1, n);
		}
	}

	// ── graceTurns: minimum 1 ──

	get graceTurns(): number {
		return this._graceTurns;
	}

	set graceTurns(n: number) {
		this._graceTurns = Math.max(1, n);
	}

	// ── maxConcurrent: minimum 1 ──

	get maxConcurrent(): number {
		return this._maxConcurrent;
	}

	set maxConcurrent(n: number) {
		this._maxConcurrent = Math.max(1, n);
	}

	// ── modelTiers: tier → model map for the subagent tool's model_tier param ──

	get modelTiers(): ModelTierMap {
		return this._modelTiers;
	}

	// ── Lifecycle methods ──

	/**
	 * Load merged settings (global + project), apply to in-memory values,
	 * and emit the `subagents:settings_loaded` lifecycle event.
	 * Returns the raw loaded settings object.
	 */
	load(): SubagentsSettings {
		const settings = loadSettings(this.agentDir, this.cwd);
		if (typeof settings.maxConcurrent === "number") this.maxConcurrent = settings.maxConcurrent;
		if (typeof settings.defaultMaxTurns === "number") this.defaultMaxTurns = settings.defaultMaxTurns;
		if (typeof settings.graceTurns === "number") this.graceTurns = settings.graceTurns;
		this._modelTiers = settings.modelTiers ? { ...settings.modelTiers } : {};
		this.emit("subagents:settings_loaded", { settings });
		return settings;
	}

	/**
	 * Snapshot current in-memory values for persistence.
	 * `defaultMaxTurns` uses 0 as the on-disk marker for unlimited (undefined).
	 * `modelTiers` is omitted when empty so hand-edited tier maps are only
	 * rewritten (not replaced with an empty object) when they exist.
	 */
	snapshot(): { maxConcurrent: number; defaultMaxTurns: number; graceTurns: number; modelTiers?: ModelTierMap } {
		return {
			maxConcurrent: this._maxConcurrent,
			defaultMaxTurns: this._defaultMaxTurns ?? 0,
			graceTurns: this._graceTurns,
			...(Object.keys(this._modelTiers).length > 0 ? { modelTiers: { ...this._modelTiers } } : {}),
		};
	}

	/**
	 * Set maxConcurrent, notify interested parties, persist, and return the toast.
	 * Owns the full consequence chain so callers just say what they want.
	 */
	applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" } {
		this.maxConcurrent = n; // setter normalizes: max(1, n)
		this.onMaxConcurrentChanged?.();
		return this.saveAndNotify(`Max concurrency set to ${this.maxConcurrent}`);
	}

	/**
	 * Set defaultMaxTurns, persist, and return the toast.
	 * Pass 0 for unlimited (maps to undefined internally).
	 */
	applyDefaultMaxTurns(n: number): { message: string; level: "info" | "warning" } {
		this.defaultMaxTurns = n === 0 ? undefined : n; // setter normalizes further
		const label = this.defaultMaxTurns == null ? "unlimited" : String(this.defaultMaxTurns);
		return this.saveAndNotify(`Default max turns set to ${label}`);
	}

	/**
	 * Set graceTurns, persist, and return the toast.
	 */
	applyGraceTurns(n: number): { message: string; level: "info" | "warning" } {
		this.graceTurns = n; // setter normalizes: max(1, n)
		return this.saveAndNotify(`Grace turns set to ${this.graceTurns}`);
	}

	/**
	 * Persist the current snapshot, emit `subagents:settings_changed`,
	 * and return the toast the UI should display.
	 */
	saveAndNotify(successMsg: string): { message: string; level: "info" | "warning" } {
		const snap = this.snapshot();
		const persisted = saveSettings(snap, this.cwd);
		this.emit("subagents:settings_changed", { settings: snap, persisted });
		return persistToastFor(successMsg, persisted);
	}
}

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentsSettings {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: SubagentsSettings = {};
	if (
		Number.isInteger(r.maxConcurrent) &&
		(r.maxConcurrent as number) >= 1 &&
		(r.maxConcurrent as number) <= MAX_CONCURRENT_CEILING
	) {
		out.maxConcurrent = r.maxConcurrent as number;
	}
	if (
		Number.isInteger(r.defaultMaxTurns) &&
		(r.defaultMaxTurns as number) >= 0 &&
		(r.defaultMaxTurns as number) <= MAX_TURNS_CEILING
	) {
		out.defaultMaxTurns = r.defaultMaxTurns as number;
	}
	if (
		Number.isInteger(r.graceTurns) &&
		(r.graceTurns as number) >= 1 &&
		(r.graceTurns as number) <= GRACE_TURNS_CEILING
	) {
		out.graceTurns = r.graceTurns as number;
	}
	const modelTiers = sanitizeModelTiers(r.modelTiers);
	if (modelTiers) out.modelTiers = modelTiers;
	return out;
}

/**
 * Keep only known tier names with non-empty string values (trimmed).
 * Returns `undefined` when nothing survives — an empty map is the same as
 * "not configured" everywhere else.
 */
function sanitizeModelTiers(raw: unknown): ModelTierMap | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const source = raw as Record<string, unknown>;
	const out: ModelTierMap = {};
	for (const tier of MODEL_TIERS) {
		const value = source[tier];
		if (typeof value === "string" && value.trim()) out[tier] = value.trim();
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function projectPath(cwd: string): string {
	return join(cwd, ".pi", "subagents.json");
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(agentDir: string, cwd: string): SubagentsSettings {
	return loadLayeredSettings({
		agentDir,
		cwd,
		filename: "subagents.json",
		sanitize,
		warnLabel: "pi-subagents",
		merge: mergeSettings,
	} satisfies LayeredSettingsSource<SubagentsSettings>);
}

/**
 * Shallow-merge scalars (project wins), but merge `modelTiers` per tier so a
 * project can override one tier without restating the global map.
 */
function mergeSettings(global: SubagentsSettings, project: SubagentsSettings): SubagentsSettings {
	const modelTiers: ModelTierMap = { ...global.modelTiers, ...project.modelTiers };
	return {
		...global,
		...project,
		...(Object.keys(modelTiers).length > 0 ? { modelTiers } : {}),
	};
}

/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
	const path = projectPath(cwd);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
		return true;
	} catch {
		return false;
	}
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
	successMsg: string,
	persisted: boolean,
): { message: string; level: "info" | "warning" } {
	return persisted
		? { message: successMsg, level: "info" }
		: { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}
