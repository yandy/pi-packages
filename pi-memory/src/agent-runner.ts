import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./model-resolver";

/** Thinking level used by the agent. Mirrors @earendil-works/pi-agent-core. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const MEMORY_AGENT_TOOLS = ["read", "write", "edit", "ls"] as const;

export interface HeadlessAgentOpts {
  task: string;
  cwd: string;
  modelRegistry: ModelRegistry;
  model?: string;
  parentModel?: Model<any>;
  thinkLevel?: ThinkingLevel;
  maxTurns?: number;
  timeoutMs?: number;
}

/**
 * Run a headless AgentSession with turn and timeout protection.
 *
 * Creates a minimal sandboxed AgentSession (no extensions, skills, context
 * files, prompt templates, or themes) and runs the given task.  Collects
 * streamed assistant text and protects against runaway agents with a soft
 * limit (steer at maxTurns) + hard limit (abort at maxTurns+3) and a
 * configurable timeout.
 *
 * @returns The collected assistant response text.
 * @throws Error if the session times out, is aborted, or prompts throws.
 */
export async function runHeadlessAgent(opts: HeadlessAgentOpts): Promise<string> {
  // 1. Model resolution
  const resolvedModel: Model<any> | undefined = !opts.model
    ? opts.parentModel
    : resolveModel(opts.model, opts.modelRegistry) ?? opts.parentModel;

  // 2. Pure resource loader — no extensions, skills, context files, etc.
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

  // 3. Create AgentSession
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    tools: MEMORY_AGENT_TOOLS as unknown as string[],
    model: resolvedModel,
    thinkingLevel: opts.thinkLevel,
    modelRegistry: opts.modelRegistry,
    sessionManager: SessionManager.inMemory(opts.cwd),
    settingsManager,
    resourceLoader: loader,
  });

  // 4. Response collection + turn counting
  let responseText = "";
  let currentTurnText = "";
  let turns = 0;

  const unsub = session.subscribe((event) => {
    switch (event.type) {
      case "message_start":
        currentTurnText = "";
        break;
      case "message_update": {
        const delta = (event as any).assistantMessageEvent?.delta;
        if (typeof delta === "string") currentTurnText += delta;
        break;
      }
      case "message_end":
        responseText += currentTurnText;
        break;
      case "turn_end":
        turns++;
        if (opts.maxTurns && turns >= opts.maxTurns) {
          session.steer("Please wrap up and provide a final response.").catch(() => {});
        }
        if (opts.maxTurns && turns >= opts.maxTurns + 3) {
          session.abort().catch(() => {});
        }
        break;
    }
  });

  // 5. Timeout using Promise.race
  let timeoutReject: ((e: Error) => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = opts.timeoutMs
    ? new Promise<never>((_, reject) => {
        timeoutReject = reject;
      })
    : null;

  if (opts.timeoutMs && timeoutReject) {
    timeout = setTimeout(() => {
      session.abort().catch(() => {});
      timeoutReject!(new Error(`Timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
  }

  // 6. Run
  try {
    if (timeoutPromise) {
      await Promise.race([session.prompt(opts.task), timeoutPromise]);
    } else {
      await session.prompt(opts.task);
    }
    return responseText || (session.getLastAssistantText() ?? "");
  } catch (e: any) {
    throw new Error(e.message ?? "Unknown error");
  } finally {
    clearTimeout(timeout);
    unsub();
    session.dispose().catch(() => {});
  }
}
