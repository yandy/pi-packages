import { readFile, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { MemoryConfig } from "./config";

export interface DreamMeta { lastDreamAt: string; sessionCountAtDream: number; }

const META_FILE = ".dream-meta.json";

export async function readDreamMeta(memoryDir: string): Promise<DreamMeta | null> {
	try {
		const raw = await readFile(join(memoryDir, META_FILE), "utf8");
		return JSON.parse(raw) as DreamMeta;
	} catch {
		return null;
	}
}

export async function writeDreamMeta(memoryDir: string, sessionCount: number): Promise<void> {
	const meta: DreamMeta = { lastDreamAt: new Date().toISOString(), sessionCountAtDream: sessionCount };
	await writeFile(join(memoryDir, META_FILE), JSON.stringify(meta), "utf8");
}

export function formatNudge(sessions: number, newEntries: number): string {
	return `💡 ${sessions} sessions, ${newEntries} new entries since last dream. /dream`;
}

export async function shouldNudge(
	memoryDir: string,
	config: MemoryConfig,
	cwd: string,
): Promise<{ nudge: boolean; message: string; sessions: number; newEntries: number }> {
	const sessions = (await SessionManager.list(cwd)).length;
	const meta = await readDreamMeta(memoryDir);
	const newEntries = meta ? Math.max(0, sessions - meta.sessionCountAtDream) : sessions;
	if (meta) {
		const hoursSince = (Date.now() - new Date(meta.lastDreamAt).getTime()) / 3600_000;
		if (hoursSince >= config.dream.nudgeAfterHours && newEntries >= config.dream.nudgeAfterSessions) {
			return { nudge: true, message: formatNudge(sessions, newEntries), sessions, newEntries };
		}
	} else if (sessions >= config.dream.nudgeAfterSessions) {
		return { nudge: true, message: formatNudge(sessions, newEntries), sessions, newEntries };
	}
	return { nudge: false, message: "", sessions: 0, newEntries: 0 };
}
