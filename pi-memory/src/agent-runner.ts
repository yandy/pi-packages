import type { Model } from "@earendil-works/pi-ai";
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
import type { ThinkLevel } from "./config";
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
}

const GRACE_TURNS = 1;

/**
 * Run a headless memory-agent sub-session: create an in-memory, resource-free
 * session, drive the turn loop, collect the assistant response text, and dispose.
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

	// 3. Forward abort signal BEFORE createAgentSession (handle early abort)
	let session: AgentSession | undefined;
	const onAbort = (): void => {
		void session?.abort();
	};
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	// 4. Create the in-memory session (no bindExtensions)
	const created = await createAgentSession({
		cwd: opts.cwd,
		tools: [...MEMORY_AGENT_TOOLS],
		model: resolvedModel as any,
		thinkingLevel: opts.thinkLevel as any,
		modelRegistry: opts.modelRegistry,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager,
		resourceLoader: loader,
	});
	session = created.session as AgentSession;

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
