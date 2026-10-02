import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { FILE_IO_TOOLS } from "./agent-config";
import type { SessionPersistenceConfig, ThinkLevel } from "./config";
import { resolveModel } from "./model-resolver";

export interface HeadlessAgentOpts {
	task: string;
	cwd: string;
	modelRegistry: import("@earendil-works/pi-coding-agent").ModelRegistry;
	/** 必填：模型必须来自显式配置（启动校验已经保证可解析），没有父模型回退。 */
	model: string;
	thinkLevel?: ThinkLevel;
	maxTurns?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Session persistence config. When enabled, sessions are written to disk. */
	sessionPersistence?: SessionPersistenceConfig;
	/**
	 * Built-in tool name allowlist. Defaults to FILE_IO_TOOLS.
	 *
	 * **警告：这是白名单，会把 `customTools` 一起过滤掉**（`createAgentSession` 的
	 * `allowedToolNames` 与 `agent-session` 的 `isAllowedTool` 同时作用于 builtin 与 custom tools）。
	 * 要「关 builtin、只留 custom tools」必须用 `noTools: "builtin"`，不要传 `tools: []` ——
	 * `tools: []` 会把 customTools 也滤掉，dream 一个原语都调不到却会「成功」返回。
	 */
	tools?: string[];
	/**
	 * Default tool suppression mode when no explicit allowlist is provided.
	 * - `"all"`: 连 customTools 也不启用（零工具）。
	 * - `"builtin"`: 关掉默认 builtin 工具（read/write/edit/ls），但保留 customTools。
	 */
	noTools?: "all" | "builtin";
	/** Custom tool definitions. Defaults to []. */
	customTools?: ToolDefinition[];
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
	// 模型必须显式配置且可解析：启动校验之外再挡一次（会话中途凭据被移除等），
	// 结果是显式失败，而不是静默用父会话模型跑一个用户没选的模型。
	const resolvedModel = resolveModel(opts.model, opts.modelRegistry);
	if (!resolvedModel) {
		throw new Error(`model "${opts.model}" is not resolvable (unknown id or missing credentials)`);
	}

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
		// `noTools` 时不注入默认白名单：白名单会把 customTools 一起滤掉（见 HeadlessAgentOpts.tools）。
		tools: opts.tools ?? (opts.noTools ? undefined : [...FILE_IO_TOOLS]),
		noTools: opts.noTools,
		customTools: opts.customTools ?? [],
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
