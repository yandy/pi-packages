import type { Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MEMORY_AGENT_TOOLS } from "./agent-config";
import type { SessionPersistenceConfig, ThinkLevel } from "./config";
import { resolveModel } from "./model-resolver";

export interface HeadlessAgentOpts {
	task: string;
	cwd: string;
	modelRegistry: import("@earendil-works/pi-coding-agent").ModelRegistry;
	model?: string;
	parentModel?: Model<any>;
	thinkLevel?: ThinkLevel;
	maxTurns?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Session persistence config. When enabled, sessions are written to disk. */
	sessionPersistence?: SessionPersistenceConfig;
}

const GRACE_TURNS = 1;

/**
 * Run a headless memory-agent sub-session: create a session (in-memory by default,
 * persisted to disk when sessionPersistence.enabled is true), drive the turn loop,
 * collect the assistant response text, and dispose.
 *
 * Does NOT call bindExtensions — no extension hooks fire in the sub-session,
 * so pi-memory's own before_agent_start cannot recurse.
 */
export async function runHeadlessAgent(opts: HeadlessAgentOpts): Promise<string> {
	// 1. Resolve model: undefined → parentModel; otherwise fuzzy resolve (fallback parent)
	const resolvedModel = !opts.model
		? opts.parentModel
		: (resolveModel(opts.model, opts.modelRegistry) ?? opts.parentModel);

	// 2. Build a pure resource loader (no extensions/skills/context files/etc.)
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();

	// 3. Create session (in-memory or persisted based on config)
	const sessionManager = opts.sessionPersistence?.enabled
		? SessionManager.create(
				opts.cwd,
				opts.sessionPersistence.sessionDir ?? join(opts.cwd, "sessions"),
			)
		: SessionManager.inMemory(opts.cwd);

	const created = await createAgentSession({
		cwd: opts.cwd,
		tools: [...MEMORY_AGENT_TOOLS],
		model: resolvedModel as any,
		thinkingLevel: opts.thinkLevel as any,
		modelRegistry: opts.modelRegistry,
		sessionManager,
		settingsManager,
		resourceLoader: loader,
	});

	// 4. Forward abort signal after session exists (avoid listener leak if creation throws)
	let session: AgentSession | undefined = created.session as AgentSession;
	const onAbort = (): void => {
		void session?.abort();
	};
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	// 5. Collect response text + enforce turn limits
	let text = "";
	let turnCount = 0;
	let softLimitReached = false;
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_start") {
			text = "";
		} else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			text += event.assistantMessageEvent.delta;
		} else if (event.type === "turn_end") {
			turnCount++;
			if (opts.maxTurns != null) {
				if (!softLimitReached && turnCount >= opts.maxTurns) {
					softLimitReached = true;
					void session.steer("You have reached your turn limit. Finish now.");
				} else if (softLimitReached && turnCount >= opts.maxTurns + GRACE_TURNS) {
					void session.abort();
				}
			}
		}
	});

	try {
		// 6. Drive prompt (with optional timeout)
		const promptPromise = session.prompt(opts.task);
		if (opts.timeoutMs != null) {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutId = setTimeout(
					() => reject(new Error(`headless agent timed out after ${opts.timeoutMs}ms`)),
					opts.timeoutMs,
				);
			});
			await Promise.race([promptPromise, timeoutPromise]).finally(() => {
				if (timeoutId) clearTimeout(timeoutId);
			});
		} else {
			await promptPromise;
		}
		return text || (session.getLastAssistantText() ?? "");
	} finally {
		opts.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose?.();
	}
}
