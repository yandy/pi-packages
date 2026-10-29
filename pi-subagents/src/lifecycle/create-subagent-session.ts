/**
 * create-subagent-session.ts — Assembly factory for born-complete child sessions (issue #265).
 *
 * `createSubagentSession()` does the assembly portion that the old runner's
 * `runAgent()` did up front: detect the environment, assemble the session config,
 * create the SDK session, publish `spawning`/`session-created`, bind extensions,
 * and apply the recursion guard. It returns a fully usable `SubagentSession` —
 * `Subagent` then only coordinates (turn loop, steer, dispose).
 *
 * Every child runs in the parent's cwd: `snapshot.cwd` feeds detectEnv,
 * assembleSessionConfig and createSession directly.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfigLookup } from "../config/agent-types";
import type { ChildLifecyclePublisher } from "../lifecycle/child-lifecycle";
import type { ParentSnapshot } from "../lifecycle/parent-snapshot";
import { SubagentSession } from "../lifecycle/subagent-session";
import type { EnvInfo } from "../session/env";
import { type AssemblerIO, assembleSessionConfig, type SessionConfig } from "../session/session-config";
import type { ParentSessionInfo, ShellExec, SubagentType, ThinkingLevel } from "../types";

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES = ["subagent", "get_subagent_result", "steer_subagent"];

/**
 * Apply the recursion guard: remove this extension's dispatch tools from the
 * child's active set. Runs after `bindExtensions` so extension-registered tools
 * are also covered. Unconditional: children always load the parent's extensions.
 */
function applyRecursionGuard(session: AgentSession): void {
	const filtered = session.getActiveToolNames().filter((t) => !EXCLUDED_TOOL_NAMES.includes(t));
	session.setActiveToolsByName(filtered);
}

// ── IO boundary ───────────────────────────────────────────────────────────────

/** Minimal resource-loader contract used by the factory. */
export interface ResourceLoaderLike {
	reload(): Promise<void>;
}

/** Minimal session-manager contract used by the factory. */
export interface SessionManagerLike {
	newSession(opts: { parentSession?: string }): void;
	getSessionFile(): string | undefined;
	getSessionId(): string;
}

/** Options passed to EnvironmentIO/SessionFactoryIO methods. */
export interface ResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPromptOverride?: () => string;
	/** Override the append system prompt. Receives the current base value; return the replacement. */
	appendSystemPromptOverride?: (base: string[]) => string[];
}

/** Options passed to SessionFactoryIO.createSession. */
export interface CreateSessionOptions {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManagerLike;
	settingsManager: SettingsManager;
	modelRegistry: unknown;
	model?: unknown;
	tools: string[];
	resourceLoader: ResourceLoaderLike;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Environment discovery - detect runtime context and resolve directories.
 *
 * Decouples the factory from direct process/SDK reads so each can be stubbed
 * independently in tests.
 */
export interface EnvironmentIO {
	detectEnv: (exec: ShellExec, cwd: string) => Promise<EnvInfo>;
	getAgentDir: () => string;
	deriveSessionDir: (parentSessionFile: string | undefined, cwd: string) => string;
}

/**
 * Session factory - create SDK objects for a child agent session.
 *
 * Decouples the factory from direct Pi SDK imports and sibling-module IO,
 * making it testable via plain stub objects without vi.mock().
 */
export interface SessionFactoryIO {
	createResourceLoader: (opts: ResourceLoaderOptions) => ResourceLoaderLike;
	createSessionManager: (cwd: string, sessionDir: string) => SessionManagerLike;
	createSettingsManager: (cwd: string, agentDir: string) => SettingsManager;
	createSession: (opts: CreateSessionOptions) => Promise<{ session: AgentSession }>;
	assemblerIO: AssemblerIO;
}

/**
 * IO boundary injected into createSubagentSession().
 *
 * Intersection of EnvironmentIO and SessionFactoryIO — callers satisfy both
 * sub-interfaces via TypeScript's structural typing.
 */
export type SubagentSessionIO = EnvironmentIO & SessionFactoryIO;

/**
 * Dependencies injected at construction time — the IO boundary plus the two
 * static domain deps (exec, registry) every creation needs.
 */
export interface SubagentSessionDeps {
	io: SubagentSessionIO;
	exec: ShellExec;
	registry: AgentConfigLookup;
	/** Publishes the child-execution lifecycle so consumers can observe it. */
	lifecycle: ChildLifecyclePublisher;
}

/** Per-spawn parameters — the fields that vary per child session. */
export interface CreateSubagentSessionParams {
	snapshot: ParentSnapshot;
	type: SubagentType;
	/** Parent session identity (file path + session ID). */
	parentSession?: ParentSessionInfo;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Map a session config onto resource-loader options.
 *
 * "append": no system-prompt override, so the harness renders the base prompt
 * for the child's own tool set (tool list, tool guidelines, skills, AGENTS.md,
 * SYSTEM.md, APPEND_SYSTEM.md, date/cwd); we only append our section, keeping
 * any APPEND_SYSTEM.md content ahead of it.
 *
 * "replace": we own the whole prompt, so the system prompt is overridden and
 * both context files and the append file are suppressed.
 *
 * Exported (and kept free of IO) so the harness contract it depends on can be
 * exercised against a real DefaultResourceLoader instead of a mock.
 */
export function buildResourceLoaderOptions(cfg: SessionConfig, agentDir: string): ResourceLoaderOptions {
	const isReplace = cfg.promptMode === "replace";
	return {
		cwd: cfg.cwd,
		agentDir,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: isReplace,
		// Written out instead of spread conditionals: a conditional spread defeats
		// TypeScript's excess-property check, and a typo here would silently fall
		// back to append semantics (the bug this change exists to fix).
		systemPromptOverride: isReplace ? () => cfg.promptSection : undefined,
		appendSystemPromptOverride: isReplace ? () => [] : (base: string[]) => [...base, cfg.promptSection],
	};
}

/**
 * Build a born-complete SubagentSession: assemble config, create the SDK
 * session, publish lifecycle events, bind extensions, apply the recursion guard.
 */
export async function createSubagentSession(
	params: CreateSubagentSessionParams,
	deps: SubagentSessionDeps,
): Promise<SubagentSession> {
	const { snapshot, type } = params;
	const parentSessionId = params.parentSession?.parentSessionId;
	deps.lifecycle.spawning({ agentName: type, parentSessionId });

	// detectEnv runs before assembly, so it reads the cwd from the snapshot directly.
	const env = await deps.io.detectEnv(deps.exec, snapshot.cwd);

	// Assemble session configuration (synchronous, no SDK objects).
	const cfg = assembleSessionConfig(
		type,
		{
			cwd: snapshot.cwd,
			parentModel: snapshot.model,
			modelRegistry: snapshot.modelRegistry,
		},
		{
			model: params.model,
			thinkingLevel: params.thinkingLevel,
		},
		env,
		deps.registry,
		deps.io.assemblerIO,
	);

	const agentDir = deps.io.getAgentDir();

	// Children always load the parent's extensions and skills.
	//
	// "append" lets the harness render the base prompt for the child's own tool
	// set (tool list, tool guidelines, skills, AGENTS.md, SYSTEM.md, date/cwd)
	// and appends our section to it. "replace" owns the whole prompt, so context
	// files and the append file are suppressed.
	const loader = deps.io.createResourceLoader(buildResourceLoaderOptions(cfg, agentDir));
	await loader.reload();

	// Create a persisted SessionManager so transcripts are written in Pi's
	// official JSONL format. Falls back to a temp directory when the parent
	// session is not persisted (e.g. headless/API mode).
	const sessionDir = deps.io.deriveSessionDir(params.parentSession?.parentSessionFile, cfg.cwd);
	const sessionManager = deps.io.createSessionManager(cfg.cwd, sessionDir);
	sessionManager.newSession({ parentSession: params.parentSession?.parentSessionId });
	const sessionId = sessionManager.getSessionId();

	const { session } = await deps.io.createSession({
		cwd: cfg.cwd,
		agentDir,
		sessionManager,
		settingsManager: deps.io.createSettingsManager(cfg.cwd, agentDir),
		modelRegistry: snapshot.modelRegistry,
		model: cfg.model,
		tools: cfg.toolNames,
		resourceLoader: loader,
		thinkingLevel: cfg.thinkingLevel,
	});

	const subagentSession = new SubagentSession(session, {
		outputFile: sessionManager.getSessionFile(),
		sessionId,
		sessionDir,
		agentName: type,
		agentMaxTurns: cfg.agentMaxTurns,
		parentContext: snapshot.parentContext,
		lifecycle: deps.lifecycle,
	});

	// Publish session-created before bindExtensions() so observers (e.g. the
	// permission system) can register the child synchronously and have their
	// entry in place for the first permission check during child extension
	// initialization. The event bus dispatches synchronously, so a synchronous
	// subscriber completes before this returns.
	deps.lifecycle.sessionCreated({ sessionId, parentSessionId });

	try {
		// Bind extensions so that session_start fires and extensions can initialize.
		await session.bindExtensions({});
		// Apply recursion guard after bindExtensions so extension-registered tools
		// are included in the post-bind active set.
		applyRecursionGuard(session);
	} catch (err) {
		// Binding failed after session-created — dispose (emit disposed +
		// session.dispose()) before rethrowing so registration is never leaked.
		subagentSession.dispose();
		throw err;
	}

	return subagentSession;
}
