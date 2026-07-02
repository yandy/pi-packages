import {
	createAgentSession,
	SessionManager,
	DefaultResourceLoader,
	SettingsManager,
	AuthStorage,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { MemoryConfig } from "./config";

export const DREAM_SYSTEM_PROMPT = `You are a memory consolidation agent. Your job: read all memory files in the given directory, deduplicate entries, merge contradictions, update outdated info, and reorganize the MEMORY.md index to be concise and accurate.
Rules:
- Only modify files under the given directory. Never touch anything else.
- Preserve all valuable knowledge; only remove true duplicates or outdated facts.
- Keep MEMORY.md within the stated line limit; each line: - [Title](file.md) — description.
- Write specific descriptions so the index alone tells what each file holds.
- When done, output a concise summary of changes (merged N, removed N, updated N).`;

export function buildDreamTask(memoryDir: string, maxLines: number): string {
	return `Consolidate the memory files under ${memoryDir}. Read every .md file (including MEMORY.md), then:
1. Deduplicate entries that say the same thing.
2. Merge contradictory or overlapping entries into one accurate entry.
3. Update outdated information.
4. Reorganize MEMORY.md so it stays <= ${maxLines} lines, one pointer per topic file: - [Title](file.md) — description.
Only edit files under ${memoryDir}. When finished, print a one-line summary of changes.`;
}

export function resolveDreamModel(config: MemoryConfig, ctx: { model: any; modelRegistry: any }): any | null {
	if (config.dream.model === "auto") return ctx.model;
	const slash = config.dream.model.indexOf("/");
	if (slash === -1) return null;
	const provider = config.dream.model.slice(0, slash);
	const id = config.dream.model.slice(slash + 1);
	return ctx.modelRegistry?.find(provider, id) ?? null;
}

export function extractSummary(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant") {
			if (typeof m.content === "string") return m.content;
			const t = (m.content || []).find((b: any) => b.type === "text");
			if (t) return t.text;
		}
	}
	return "Dream completed.";
}

interface RunDreamOpts {
	model: any;
	memoryDir: string;
	cwd: string;
	signal?: AbortSignal;
	createSession?: typeof createAgentSession;
}

export async function runDream(opts: RunDreamOpts): Promise<string> {
	const createSession = opts.createSession ?? createAgentSession;
	// DI: when opts.createSession is provided (test path), skip real loader/auth construction.
	// When not provided (production), build the real isolated DefaultResourceLoader + AuthStorage.
	const useReal = !opts.createSession;
	const loader = useReal
		? await (async () => {
				const isolatedAgentDir = await mkdtemp(join(tmpdir(), "pi-dream-"));
				const l = new DefaultResourceLoader({
					cwd: opts.memoryDir,
					agentDir: isolatedAgentDir,
					settingsManager: SettingsManager.inMemory({}),
					systemPromptOverride: () => DREAM_SYSTEM_PROMPT,
				});
				await l.reload();
				return l;
			})()
		: undefined;
	const authStorage = useReal ? AuthStorage.create() : undefined;

	const { session } = await createSession({
		model: opts.model,
		...(authStorage ? { authStorage } : {}),
		...(useReal ? { modelRegistry: ModelRegistry.create(authStorage!) } : {}),
		tools: ["read", "edit", "write"],
		cwd: opts.memoryDir,
		sessionManager: useReal ? SessionManager.inMemory(opts.memoryDir) : undefined,
		...(loader ? { resourceLoader: loader } : {}),
	});

	let summary = "Dream completed.";
	const unsub = session.subscribe((e: any) => {
		if (e.type === "agent_end") {
			summary = extractSummary(session.messages);
		}
	});

	const onAbort = () => session.abort?.();
	opts.signal?.addEventListener("abort", onAbort);
	try {
		await session.prompt(buildDreamTask(opts.memoryDir, 200));
		// Extract from messages as fallback when agent_end didn't fire (test path / edge case).
		if (summary === "Dream completed." && session.messages?.length) {
			summary = extractSummary(session.messages);
		}
		return summary;
	} finally {
		opts.signal?.removeEventListener("abort", onAbort);
		unsub();
		session.dispose();
	}
}
