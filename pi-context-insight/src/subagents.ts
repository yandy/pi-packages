import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import type { LoadedSubagent, ReadonlySessionManager, SubagentLoadResult, SubagentMetadata } from "./model";

const SUBAGENT_RECORD = "subagents:record";
const MAX_LINEAGE_DEPTH = 16;
const ACTIVE_AGENT_RE = /<active_agent\s+name="([^"]+)"\s*\/>/;

interface LineageRoot {
	sessionId: string;
	tasksDir: string;
}

interface RecordData {
	id: string;
	type?: string;
	description?: string;
	status?: string;
	modelName?: string;
	thinking?: string;
	startedAt?: number;
	completedAt?: number;
}

interface Candidate {
	filePath: string;
	root: LineageRoot;
	record?: RecordData;
}

function tasksDirFor(sessionFile: string): string {
	return join(dirname(sessionFile), basename(sessionFile, ".jsonl"), "tasks");
}

function ephemeralTasksDir(parent: ReadonlySessionManager): string {
	const encoded = parent
		.getCwd()
		.replace(/[/\\]/g, "-")
		.replace(/^[A-Za-z]:-/, "")
		.replace(/^-+/, "");
	return join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encoded, "tasks");
}

function directChild(root: string, filePath: string): boolean {
	const rel = relative(root, filePath);
	return rel.length > 0 && rel === basename(rel) && !isAbsolute(rel);
}

function readSessionReadOnly(filePath: string): SessionManager {
	const entries = parseSessionEntries(readFileSync(filePath, "utf8"));
	const header = entries.find((entry) => entry.type === "session");
	return SessionManager.inMemory(header?.cwd ?? dirname(filePath), undefined, entries);
}

function lineageRoots(parent: ReadonlySessionManager, warnings: string[], ephemeralDir?: string): LineageRoot[] {
	const parentFile = parent.getSessionFile();
	if (!parentFile) return [{ sessionId: parent.getSessionId(), tasksDir: ephemeralDir ?? ephemeralTasksDir(parent) }];

	const roots: LineageRoot[] = [];
	const visited = new Set<string>();
	let manager: ReadonlySessionManager = parent;
	let sessionFile = parentFile;
	for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
		let realFile: string;
		try {
			realFile = realpathSync(sessionFile);
		} catch (error) {
			warnings.push(
				`Cannot resolve session lineage file ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
			);
			break;
		}
		if (visited.has(realFile)) {
			warnings.push(`Session lineage contains a cycle at ${realFile}`);
			break;
		}
		visited.add(realFile);
		const header = manager.getHeader();
		if (!header) {
			warnings.push(`Session lineage has no header: ${realFile}`);
			break;
		}
		roots.push({ sessionId: header.id, tasksDir: tasksDirFor(realFile) });
		if (typeof header.parentSession !== "string" || !header.parentSession.endsWith(".jsonl")) break;
		if (depth + 1 >= MAX_LINEAGE_DEPTH) {
			warnings.push(`Session lineage exceeds ${MAX_LINEAGE_DEPTH} files`);
			break;
		}
		try {
			const linkedPath = isAbsolute(header.parentSession)
				? header.parentSession
				: resolve(dirname(realFile), header.parentSession);
			manager = readSessionReadOnly(linkedPath);
			sessionFile = linkedPath;
		} catch (error) {
			warnings.push(
				`Cannot open ancestor session ${header.parentSession}: ${error instanceof Error ? error.message : String(error)}`,
			);
			break;
		}
	}
	return roots;
}

function parseRecord(data: unknown): RecordData | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const raw = data as Record<string, unknown>;
	if (typeof raw.id !== "string" || raw.id.length === 0 || typeof raw.status !== "string" || raw.status.length === 0) {
		return undefined;
	}
	const record: RecordData = { id: raw.id, status: raw.status };
	for (const key of ["type", "description", "modelName", "thinking"] as const) {
		if (typeof raw[key] === "string") record[key] = raw[key];
	}
	for (const key of ["startedAt", "completedAt"] as const) {
		const value = raw[key];
		if (typeof value === "number" && Number.isFinite(value)) record[key] = value;
	}
	return record;
}

function activeAgentType(manager: SessionManager, warnings: string[]): string | undefined {
	for (const entry of manager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "system") continue;
		const message = entry.message;
		let content = "";
		if (typeof message.content === "string") content = message.content;
		else if (Array.isArray(message.content)) {
			content = message.content
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("\n");
		} else {
			warnings.push(`Malformed system content in subagent ${manager.getSessionId()}; active agent metadata was skipped`);
			continue;
		}
		const sections = Object.values(message.sections ?? {}).filter((value): value is string => typeof value === "string");
		const match = ACTIVE_AGENT_RE.exec([content, ...sections].join("\n"));
		if (match) return match[1];
	}
	return undefined;
}

function openCandidate(candidate: Candidate): { manager: SessionManager; filePath: string } {
	if (!isAbsolute(candidate.filePath) || !candidate.filePath.endsWith(".jsonl")) {
		throw new Error("not an absolute JSONL path");
	}
	if (!directChild(candidate.root.tasksDir, candidate.filePath)) throw new Error("outside the allowed tasks root");
	const realRoot = realpathSync(candidate.root.tasksDir);
	const realFile = realpathSync(candidate.filePath);
	if (!directChild(realRoot, realFile)) throw new Error("realpath escapes the allowed tasks root");
	if (!statSync(realFile).isFile()) throw new Error("not a file");
	const manager = readSessionReadOnly(realFile);
	if (manager.getHeader()?.parentSession !== candidate.root.sessionId) {
		throw new Error(`parentSession mismatch; expected ${candidate.root.sessionId}`);
	}
	return { manager, filePath: realFile };
}

function metadataFor(
	manager: SessionManager,
	filePath: string,
	record: RecordData | undefined,
	warnings: string[],
): SubagentMetadata {
	const fallbackId = manager.getSessionId();
	const type = record?.type ?? activeAgentType(manager, warnings) ?? "unknown";
	return {
		id: record?.id ?? fallbackId,
		type,
		description: record?.description ?? `Subagent ${fallbackId}`,
		status: record?.status ?? "untracked",
		filePath,
		...(record?.modelName === undefined ? {} : { modelName: record.modelName }),
		...(record?.thinking === undefined ? {} : { thinking: record.thinking }),
		...(record?.startedAt === undefined ? {} : { startedAt: record.startedAt }),
		...(record?.completedAt === undefined ? {} : { completedAt: record.completedAt }),
	};
}

export function loadSubagentSessions(
	parent: ReadonlySessionManager,
	options: { ephemeralTasksDir?: string } = {},
): SubagentLoadResult {
	const warnings: string[] = [];
	const roots = lineageRoots(parent, warnings, options.ephemeralTasksDir);
	const currentRoot = roots[0];
	const candidates = new Map<string, Candidate>();

	const addCandidate = (candidate: Candidate) => {
		const key = `${candidate.root.sessionId}:${resolve(candidate.filePath)}`;
		const existing = candidates.get(key);
		if (existing && candidate.record) existing.record = candidate.record;
		else if (!existing) candidates.set(key, candidate);
	};

	if (currentRoot) {
		for (const entry of parent.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== SUBAGENT_RECORD) continue;
			const record = parseRecord(entry.data);
			if (!record) {
				warnings.push(`Malformed subagent record at parent entry ${entry.id}`);
				continue;
			}
			const raw = entry.data as { outputFile?: unknown };
			if (raw.outputFile !== undefined && (typeof raw.outputFile !== "string" || raw.outputFile.length === 0)) {
				warnings.push(`Malformed outputFile in subagent record at parent entry ${entry.id}`);
				continue;
			}
			const filePath =
				typeof raw.outputFile === "string" ? raw.outputFile : join(currentRoot.tasksDir, `${record.id}.jsonl`);
			const root = roots.find((candidate) => directChild(candidate.tasksDir, filePath));
			if (!root) {
				warnings.push(`Rejected subagent path ${filePath}: outside every lineage tasks root`);
				continue;
			}
			addCandidate({ filePath, root, record });
		}
	}

	for (const root of roots) {
		if (!existsSync(root.tasksDir)) continue;
		let names: string[];
		try {
			names = readdirSync(root.tasksDir)
				.filter((name) => name.endsWith(".jsonl"))
				.sort();
		} catch (error) {
			warnings.push(
				`Cannot scan subagent directory ${root.tasksDir}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		for (const name of names) addCandidate({ filePath: join(root.tasksDir, name), root });
	}

	const sessions: LoadedSubagent[] = [];
	const seenFiles = new Set<string>();
	for (const candidate of candidates.values()) {
		try {
			const loaded = openCandidate(candidate);
			if (seenFiles.has(loaded.filePath)) continue;
			seenFiles.add(loaded.filePath);
			sessions.push({
				manager: loaded.manager,
				metadata: metadataFor(loaded.manager, loaded.filePath, candidate.record, warnings),
			});
		} catch (error) {
			warnings.push(
				`Cannot load subagent ${candidate.filePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { sessions, warnings };
}
