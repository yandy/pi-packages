import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface FakeSession {
	entries: SessionEntry[];
	branch?: SessionEntry[];
	id?: string;
	name?: string;
	file?: string;
}

export function fakeContext(session: FakeSession, over: Record<string, unknown> = {}): ExtensionCommandContext {
	const entries = session.entries;
	const branch = session.branch ?? entries;
	return {
		cwd: "/repo",
		thinkingLevel: "high",
		model: { provider: "p", id: "m", contextWindow: 200_000, maxTokens: 8192 },
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => branch,
			getSessionId: () => session.id ?? "s1",
			getSessionName: () => session.name,
			getSessionFile: () => session.file,
			getHeader: () => ({ type: "session", id: session.id ?? "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" }),
			buildSessionProjection: () => ({ messages: [], thinkingLevel: "high", model: null, entries: [] }),
		},
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
		getSystemPrompt: () => "",
		getAllTools: () => [],
		getSettings: () => ({ compaction: { enabled: true, reserveTokens: 16_384 } }),
		...over,
	} as unknown as ExtensionCommandContext;
}
