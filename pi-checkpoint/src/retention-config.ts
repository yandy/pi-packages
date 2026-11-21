import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface RetentionPolicy {
	/** Delete completed checkpoints older than this many days; null disables the age dimension. */
	retentionDays: number | null;
	/** Keep at most this many completed checkpoint refs per Git common dir; null disables the count dimension. */
	maxRefs: number | null;
}

export const RETENTION_CONFIG_FILENAME = "checkpoint.json";

/** Used only when the config file is absent; invalid config never falls back to these values. */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
	retentionDays: 30,
	maxRefs: 1000,
});

export function retentionConfigPath(agentDir: string): string {
	return join(agentDir, RETENTION_CONFIG_FILENAME);
}

export function parseRetentionPolicy(raw: unknown): RetentionPolicy {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("checkpoint config must be a JSON object");
	}
	const record = raw as Record<string, unknown>;
	return {
		retentionDays: parseRetentionField("retentionDays", record.retentionDays),
		maxRefs: parseRetentionField("maxRefs", record.maxRefs),
	};
}

function parseRetentionField(name: keyof RetentionPolicy, value: unknown): number | null {
	if (value === undefined) return DEFAULT_RETENTION_POLICY[name];
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer or null`);
	}
	return value;
}

export async function loadRetentionPolicy(agentDir: string = getAgentDir()): Promise<RetentionPolicy> {
	const path = retentionConfigPath(agentDir);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return { ...DEFAULT_RETENTION_POLICY };
		const code = (error as NodeJS.ErrnoException).code;
		throw new Error(`Unable to read checkpoint config at ${path}${code ? ` (${code})` : ""}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		// Do not forward the JSON.parse message: V8 embeds a snippet of the input.
		throw new Error(`Invalid checkpoint config at ${path}: not valid JSON`);
	}
	try {
		return parseRetentionPolicy(raw);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "invalid configuration";
		throw new Error(`Invalid checkpoint config at ${path}: ${reason}`);
	}
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
