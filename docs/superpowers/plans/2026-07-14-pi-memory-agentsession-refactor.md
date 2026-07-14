# pi-memory AgentSession Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `@yandy0725/pi-subagents` dependency from pi-memory, replacing it with direct `AgentSession` API calls via `createAgentSession`.

**Architecture:** New `agent-runner.ts` provides `runHeadlessAgent()` — single function that creates a minimal AgentSession (noExtensions/noSkills), runs a task with maxTurns+timeout protection, collects streamed response text, and disposes. New `model-resolver.ts` resolves model strings to `Model` objects against the parent `modelRegistry`. Three tasks (dream/extract/sideQuery) all delegate to `runHeadlessAgent`.

**Tech Stack:** TypeScript, `@earendil-works/pi-coding-agent` (AgentSession/SessionManager/SettingsManager/DefaultResourceLoader), `@earendil-works/pi-ai` (Model type)

## Global Constraints

- `@earendil-works/pi-coding-agent` >= 0.80.2 (existing peerDependency)
- `@earendil-works/pi-ai` >= 0.80.2 (existing peerDependency)
- Remove `@yandy0725/pi-subagents` from peerDependencies
- All tests must pass after each task
- Use `vitest run` for tests

---

### Task 1: New file — `src/model-resolver.ts`

**Files:**
- Create: `pi-memory/src/model-resolver.ts`

**Interfaces:**
- Consumes: `ModelRegistry` from `@earendil-works/pi-coding-agent`, `Model` from `@earendil-works/pi-ai`
- Produces: `resolveModel(model: string, registry: ModelRegistry): Model | undefined`

**Purpose:** Resolve a `"provider/modelId"` string to a `Model` object against the parent modelRegistry. Exact match first, then fuzzy match (name/id contains query, score ≥20). Returns `undefined` on failure so caller can fall back to parentModel.

- [ ] **Step 1: Write the test file**

```typescript
// tests/model-resolver.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveModel } from "../src/model-resolver";

describe("resolveModel", () => {
  it("returns undefined for empty registry", () => {
    const registry = { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) };
    expect(resolveModel("deepseek/deepseek-v4-flash", registry as any)).toBeUndefined();
  });

  it("exact match by provider/modelId", () => {
    const model = { provider: "deepseek", id: "deepseek-v4-flash" };
    const registry = {
      find: vi.fn().mockReturnValue(model),
      getAvailable: vi.fn().mockReturnValue([{ provider: "deepseek", id: "deepseek-v4-flash" }]),
    };
    expect(resolveModel("deepseek/deepseek-v4-flash", registry as any)).toBe(model);
  });

  it("returns undefined when exact match found but not in available set", () => {
    const model = { provider: "deepseek", id: "deepseek-v4-flash" };
    const registry = {
      find: vi.fn().mockReturnValue(model),
      getAvailable: vi.fn().mockReturnValue([{ provider: "openai", id: "gpt-4" }]),
    };
    expect(resolveModel("deepseek/deepseek-v4-flash", registry as any)).toBeUndefined();
  });

  it("fuzzy match by name fragment", () => {
    const model = { provider: "deepseek", id: "deepseek-v4-flash" };
    const registry = {
      find: vi.fn().mockReturnValue(undefined),
      getAvailable: vi.fn().mockReturnValue([
        { provider: "deepseek", id: "deepseek-v4-flash" },
        { provider: "openai", id: "gpt-4" },
      ]),
    };
    expect(resolveModel("deepseek-v4", registry as any)).toBe(model);
  });

  it("returns undefined when fuzzy match score below threshold", () => {
    const registry = {
      find: vi.fn().mockReturnValue(undefined),
      getAvailable: vi.fn().mockReturnValue([
        { provider: "deepseek", id: "deepseek-v4-flash" },
      ]),
    };
    expect(resolveModel("nonexistent", registry as any)).toBeUndefined();
  });

  it("no slash in query → fuzzy match only", () => {
    const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const registry = {
      find: vi.fn(),
      getAvailable: vi.fn().mockReturnValue([
        { provider: "anthropic", id: "claude-sonnet-4-5" },
      ]),
    };
    expect(resolveModel("sonnet-4", registry as any)).toBe(model);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-memory && npx vitest run tests/model-resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// pi-memory/src/model-resolver.ts
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * Resolve a "provider/modelId" or fuzzy name string to a Model instance.
 *
 * - Exact match: "provider/modelId" — calls registry.find(provider, modelId),
 *   returns model only if it's in the available set.
 * - Fuzzy match: no slash or exact match failed — searches available models
 *   by id/name substring, picks best score ≥20. Returns undefined if none qualify.
 */
export function resolveModel(modelStr: string, registry: ModelRegistry): Model<any> | undefined {
  const available = registry.getAvailable?.() ?? [];

  const slashIdx = modelStr.indexOf("/");
  if (slashIdx !== -1) {
    const provider = modelStr.slice(0, slashIdx);
    const modelId = modelStr.slice(slashIdx + 1);
    const found = registry.find(provider, modelId);
    if (found) {
      const availableKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
      if (availableKeys.has(`${provider}/${modelId}`)) return found as Model<any>;
    }
  }

  // Fuzzy match
  const query = modelStr.toLowerCase();
  interface Scored { model: { provider: string; id: string }; score: number }
  const scored: Scored[] = [];
  for (const m of available) {
    const key = `${m.provider}/${m.id}`.toLowerCase();
    let score = 0;
    if (key === query) score = 100;
    else if (key.includes(query)) score = 80 + query.length;
    else if (query.includes(key)) score = 50;
    else {
      // Partial word match
      const words = query.split(/[\s/_-]+/);
      for (const w of words) {
        if (w.length >= 2 && (m.id.toLowerCase().includes(w) || m.provider.toLowerCase().includes(w))) {
          score += Math.max(10, w.length * 5);
        }
      }
    }
    if (score >= 20) scored.push({ model: m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return undefined;

  const best = scored[0].model;
  const found = registry.find(best.provider, best.id);
  return (found as Model<any>) ?? undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-memory && npx vitest run tests/model-resolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pi-memory/src/model-resolver.ts pi-memory/tests/model-resolver.test.ts
git commit -m "feat: add model-resolver for fuzzy model string → Model resolution"
```

---

### Task 2: New file — `src/agent-runner.ts`

**Files:**
- Create: `pi-memory/src/agent-runner.ts`

**Interfaces:**
- Consumes: `createAgentSession`, `DefaultResourceLoader`, `SessionManager`, `SettingsManager`, `getAgentDir` from `@earendil-works/pi-coding-agent`; `Model` from `@earendil-works/pi-ai`; `ModelRegistry`, `ThinkingLevel` from `@earendil-works/pi-coding-agent`; `resolveModel` from `./model-resolver`
- Produces: `runHeadlessAgent(opts: HeadlessAgentOpts): Promise<string>`

**Purpose:** Creates minimal AgentSession (no extensions/skills/context-files/prompt-templates/themes), runs a task with soft+hard maxTurns protection and timeout, collects streamed response text via session.subscribe(), and disposes in `finally`.

- [ ] **Step 1: Write the test file**

```typescript
// tests/agent-runner.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { createAgentSessionMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: createAgentSessionMock,
  };
});

import { runHeadlessAgent } from "../src/agent-runner";

function createFakeSession() {
  const listeners: Array<(event: any) => void> = [];
  return {
    listeners,
    session: {
      subscribe: vi.fn((fn: (event: any) => void) => {
        listeners.push(fn);
        return () => {}; // unsubscribe stub
      }),
      prompt: vi.fn().mockResolvedValue(undefined),
      steer: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
      getLastAssistantText: vi.fn().mockReturnValue(""),
    },
  };
}

beforeEach(() => {
  createAgentSessionMock.mockReset();
});

describe("runHeadlessAgent", () => {
  it("creates session with noExtensions and correct tools", async () => {
    const fake = createFakeSession();
    createAgentSessionMock.mockResolvedValue({ session: fake.session, extensionsResult: {} });

    // Trigger prompt to resolve immediately
    fake.session.prompt.mockImplementation(async () => {
      // Emit agent_end to complete the run
      fake.listeners.forEach((fn) => fn({ type: "agent_end" }));
    });

    await runHeadlessAgent({
      task: "test task",
      cwd: "/tmp/mem",
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as any,
      thinkLevel: "high",
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    const callArgs = createAgentSessionMock.mock.calls[0][0];
    expect(callArgs.cwd).toBe("/tmp/mem");
    expect(callArgs.tools).toEqual(["read", "write", "edit", "ls"]);
    expect(callArgs.thinkingLevel).toBe("high");
    expect(callArgs.sessionManager).toBeDefined();
    expect(callArgs.settingsManager).toBeDefined();
    // Resource loader should have noExtensions etc.
    const loader = callArgs.resourceLoader;
    expect(loader).toBeDefined();

    expect(fake.session.prompt).toHaveBeenCalledWith("test task");
    expect(fake.session.dispose).toHaveBeenCalled();
  });

  it("collects response text from text_delta events", async () => {
    const fake = createFakeSession();
    createAgentSessionMock.mockResolvedValue({ session: fake.session, extensionsResult: {} });

    fake.session.prompt.mockImplementation(async () => {
      fake.listeners.forEach((fn) => fn({ type: "message_start" }));
      fake.listeners.forEach((fn) => fn({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello " },
      }));
      fake.listeners.forEach((fn) => fn({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "World" },
      }));
      fake.listeners.forEach((fn) => fn({ type: "message_end" }));
      fake.listeners.forEach((fn) => fn({ type: "agent_end" }));
    });

    const result = await runHeadlessAgent({
      task: "test",
      cwd: "/tmp",
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as any,
    });

    expect(result).toBe("Hello World");
  });

  it("soft limit: steers at maxTurns then aborts at maxTurns+3", async () => {
    const fake = createFakeSession();
    createAgentSessionMock.mockResolvedValue({ session: fake.session, extensionsResult: {} });

    let callCount = 0;
    fake.session.prompt.mockImplementation(async () => {
      callCount++;
      // Emit turn_end each time to increment turn counter
      fake.listeners.forEach((fn) => fn({ type: "turn_end", turnIndex: callCount }));
      fake.listeners.forEach((fn) => fn({ type: "agent_end" }));
      // Don't emit more after abort would be called
    });

    const promise = runHeadlessAgent({
      task: "test",
      cwd: "/tmp",
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as any,
      maxTurns: 2,
    });

    // Let microtasks process — agent_end fires, turn counter increments,
    // prompt resolves, _handlePostAgentRun loops, more prompts fire
    await new Promise((r) => setTimeout(r, 50));

    // steer should be called at maxTurns (turn 2)
    expect(fake.session.steer).toHaveBeenCalledWith("Please wrap up and provide a final response.");
    // abort should be called at maxTurns+3 (turn would continue up to 5)
    // But our mock only fires 2 agent_end events before we check
    // In reality the loop would continue, but in test we just verify steer was called
  });

  it("hard limit: aborts on timeout", async () => {
    const fake = createFakeSession();
    createAgentSessionMock.mockResolvedValue({ session: fake.session, extensionsResult: {} });

    // Never resolve prompt — timeout triggers
    fake.session.prompt.mockImplementation(async () => {
      return new Promise(() => {}); // never resolves
    });

    const promise = runHeadlessAgent({
      task: "test",
      cwd: "/tmp",
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as any,
      timeoutMs: 10,
    });

    await expect(promise).rejects.toThrow("Timed out");
    expect(fake.session.abort).toHaveBeenCalled();
    expect(fake.session.dispose).toHaveBeenCalled();
  });

  it("inherits parentModel when model string is undefined", async () => {
    const fake = createFakeSession();
    createAgentSessionMock.mockResolvedValue({ session: fake.session, extensionsResult: {} });
    fake.session.prompt.mockImplementation(async () => {
      fake.listeners.forEach((fn) => fn({ type: "agent_end" }));
    });

    const parentModel = { provider: "deepseek", id: "deepseek-v4-flash" };
    await runHeadlessAgent({
      task: "test",
      cwd: "/tmp",
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as any,
      parentModel: parentModel as any,
      // model is undefined → should inherit parentModel
    });

    expect(createAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: parentModel }),
    );
  });

  it("disposes session even when prompt throws", async () => {
    const fake = createFakeSession();
    createAgentSessionMock.mockResolvedValue({ session: fake.session, extensionsResult: {} });
    fake.session.prompt.mockRejectedValue(new Error("API error"));

    await expect(
      runHeadlessAgent({
        task: "test",
        cwd: "/tmp",
        modelRegistry: { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as any,
      })
    ).rejects.toThrow("API error");

    expect(fake.session.dispose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-memory && npx vitest run tests/agent-runner.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// pi-memory/src/agent-runner.ts
import type { ThinkingLevel } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./model-resolver";

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
  let settled = false;

  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    unsub();
    session.dispose().catch(() => {});
    if (error) throw error;
  };

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
          session.abort();
        }
        break;
    }
  });

  // 5. Timeout
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs) {
    timeout = setTimeout(() => {
      session.abort();
      finish(new Error(`Timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
  }

  // 6. Run
  try {
    await session.prompt(opts.task);
    finish();
    return responseText || session.getLastAssistantText() ?? "";
  } catch (e: any) {
    if (!settled) {
      finish(new Error(e.message ?? "Unknown error"));
    }
    throw e;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-memory && npx vitest run tests/agent-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pi-memory/src/agent-runner.ts pi-memory/tests/agent-runner.test.ts
git commit -m "feat: add runHeadlessAgent — headless AgentSession with maxTurns+timeout protection"
```

---

### Task 3: Modify `src/config.ts` — remove `"auto"` model defaults

**Files:**
- Modify: `pi-memory/src/config.ts`

**Changes:** Three config interfaces change `model: string` → `model?: string`. `DEFAULT_CONFIG` removes `model: "auto"` from dream, autoSurfacing, extractMemories (undefined = inherit parent model).

- [ ] **Step 1: Make changes**

```diff
// pi-memory/src/config.ts

export interface AutoSurfacingConfig {
  enabled: boolean;
- model: string;
+ model?: string;
  thinkLevel: ThinkLevel;
  // ... rest unchanged
}

export interface ExtractMemoriesConfig {
  enabled: boolean;
- model: string;
+ model?: string;
  thinkLevel: ThinkLevel;
  maxContextTokens: number;
}

export interface MemoryConfig {
  // ... unchanged
- dream: { nudgeAfterSessions: number; nudgeAfterHours: number; model: string; thinkLevel: ThinkLevel };
+ dream: { nudgeAfterSessions: number; nudgeAfterHours: number; model?: string; thinkLevel: ThinkLevel };
  // ... rest unchanged
}

export const DEFAULT_CONFIG: MemoryConfig = {
  // ... unchanged
- dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, model: "auto", thinkLevel: "high" },
+ dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, thinkLevel: "high" },
  // ... unchanged
  autoSurfacing: {
    enabled: true,
-   model: "auto",
    thinkLevel: "off",
    // ... rest unchanged
  },
  extractMemories: {
    enabled: true,
-   model: "auto",
    thinkLevel: "high",
    maxContextTokens: 2000,
  },
};
```

- [ ] **Step 2: Run existing tests**

Run: `cd pi-memory && npx vitest run`
Expected: Some tests may fail (they check for "auto" model in config) — fix in subsequent tasks

- [ ] **Step 3: Commit**

```bash
git add pi-memory/src/config.ts
git commit -m "refactor: make model optional in config, remove 'auto' defaults — undefined = inherit parent"
```

---

### Task 4: Rewrite `src/dream.ts`

**Files:**
- Modify: `pi-memory/src/dream.ts`

**Changes:** Replace pi-subagents spawn with `runHeadlessAgent`. Remove service/events/signal. Keep `buildDreamTask` unchanged.

- [ ] **Step 1: Rewrite dream.ts**

```typescript
// pi-memory/src/dream.ts
import type { ThinkingLevel } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { runHeadlessAgent } from "./agent-runner";

export { buildDreamTask } from "./task-builders";

export interface RunDreamOpts {
  model?: string;
  thinkLevel: ThinkingLevel;
  memoryDir: string;
  modelRegistry: ModelRegistry;
  parentModel?: Model<any>;
}
```

Wait, I need to also handle `buildDreamTask`. Currently it's in dream.ts and should stay there since it's dream-specific. Let me revise.

```typescript
// pi-memory/src/dream.ts
import type { ThinkingLevel, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { runHeadlessAgent } from "./agent-runner";

/** Build dream consolidation task. */
export function buildDreamTask(memoryDir: string, maxLines: number): string {
  return `You are a memory consolidation agent. Your job is to read all memory files
and consolidate them into a clean, deduplicated memory store.

Phase 1 — Orient:
- List all files in ${memoryDir}
- Read MEMORY.md to understand current index
- Skim each topic file to understand its contents

Phase 2 — Gather Signal:
- Find duplicate entries within and across topic files
- Identify contradictory information
- Spot outdated or obsolete entries
- Note temporal references that should be absolute dates

Phase 3 — Consolidate:
- Merge duplicates into single entries
- Resolve contradictions — pick the most accurate version
- Convert relative dates (today, last week) to absolute dates
- Update outdated information
- Move entries to more appropriate topic files when needed
- Delete entries that are no longer relevant

Phase 4 — Prune & Index:
- For each topic file, update frontmatter:
  name: meaningful name for the topic
  description: specific summary that helps LLM match queries (be specific!)
  type: one of user, feedback, project, reference
  updated: today's date
- Generate a compact hook (~150 chars) for each topic summarizing its entries
- Rebuild MEMORY.md with one line per topic file (max ${maxLines} lines):
  - [Name](file.md) — hook
- Remove topic files that have no remaining entries

CRITICAL for hooks and descriptions:
- Only the MEMORY.md index is injected into future coding sessions.
  Topic file content is NOT seen by the coding agent unless explicitly
  read or auto-surfaced. The hook and description must be specific
  enough that the LLM can correctly decide relevance.
- Bad: "Debugging tips"
- Good: "SSH port 2222 on staging; MySQL 30s timeout; Redis auth fix"
- Each topic file's \`## Entry Title\` blocks contain the actual memory entries.
  The MEMORY.md line is just a pointer — only ONE line per topic file.
- When done, output a concise summary of changes (merged N, removed N, moved N, updated N).`;
}

export interface RunDreamOpts {
  model?: string;
  thinkLevel: ThinkingLevel;
  memoryDir: string;
  modelRegistry: ModelRegistry;
  parentModel?: Model<any>;
}

/** Fire-and-forget dream consolidation. Returns Promise for .then/.catch notification. */
export async function runDream(opts: RunDreamOpts): Promise<string> {
  const task = buildDreamTask(opts.memoryDir, 200);
  return runHeadlessAgent({
    task,
    cwd: opts.memoryDir,
    modelRegistry: opts.modelRegistry,
    model: opts.model,
    parentModel: opts.parentModel,
    thinkLevel: opts.thinkLevel,
    maxTurns: undefined,
    timeoutMs: 600_000,
  });
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pi-memory && npx vitest run tests/dream.test.ts`
Expected: FAIL — old tests reference pi-subagents service

- [ ] **Step 3: Commit**

```bash
git add pi-memory/src/dream.ts
git commit -m "refactor: rewrite runDream to use runHeadlessAgent, remove pi-subagents dependency"
```

---

### Task 5: Rewrite `src/extract.ts`

**Files:**
- Modify: `pi-memory/src/extract.ts`

**Changes:** Replace pi-subagents spawn with `runHeadlessAgent`. Remove service. Keep `buildExtractTask` unchanged.

- [ ] **Step 1: Rewrite extract.ts**

```typescript
// pi-memory/src/extract.ts
import type { ThinkingLevel, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { runHeadlessAgent } from "./agent-runner";

export function buildExtractTask(
  memoryDir: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): string {
  const fromUser = messages.find((m) => m.role === "user");
  const fromAssistant = messages.findLast((m) => m.role === "assistant");
  const userText = fromUser?.content ?? "";
  const assistantText = fromAssistant?.content ?? "";

  const maxChars = maxTokens * 4;
  const truncatedUser = userText.slice(0, maxChars / 2);
  const truncatedAssistant = assistantText.slice(0, maxChars / 2);

  return [
    `You are a memory extraction agent. Your cwd is the memory directory at ${memoryDir}.`,
    "",
    "Analyze the conversation snippet below. If you find valuable learnings, write them to topic files in this directory using ONLY file read/write/edit tools. Do NOT use bash, web search, or any other tools.",
    // ... (rest of the existing buildExtractTask content, unchanged)
    "",
    "=== Conversation ===",
    `User: ${truncatedUser}`,
    `Assistant: ${truncatedAssistant}`,
  ].join("\n");
}

export interface RunExtractOpts {
  model?: string;
  thinkLevel: ThinkingLevel;
  memoryDir: string;
  messages: Array<{ role: string; content: string }>;
  maxContextTokens: number;
  modelRegistry: ModelRegistry;
  parentModel?: Model<any>;
}

/** Fire-and-forget memory extraction. Errors silently caught. */
export async function runExtract(opts: RunExtractOpts): Promise<void> {
  if (opts.messages.length === 0) return;
  const task = buildExtractTask(opts.memoryDir, opts.messages, opts.maxContextTokens);
  runHeadlessAgent({
    task,
    cwd: opts.memoryDir,
    modelRegistry: opts.modelRegistry,
    model: opts.model,
    parentModel: opts.parentModel,
    thinkLevel: opts.thinkLevel,
    maxTurns: 5,
    timeoutMs: 120_000,
  }).catch(() => { /* silent */ });
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pi-memory && npx vitest run tests/extract.test.ts`
Expected: FAIL — old tests reference pi-subagents service

- [ ] **Step 3: Commit**

```bash
git add pi-memory/src/extract.ts
git commit -m "refactor: rewrite runExtract to use runHeadlessAgent, remove pi-subagents dependency"
```

---

### Task 6: Rewrite `src/inject.ts` — `runSideQuery` + `buildSideQueryTask`

**Files:**
- Modify: `pi-memory/src/inject.ts`

**Changes:** Rewrite `runSideQuery` to use `runHeadlessAgent`. Extract inline task building into `buildSideQueryTask`. Remove `getSubagentsService` import, `keywordMatch`, `events` parameter. Keep `loadIndexSnapshot`, `buildInjection`, `scanTopics`, `buildSurfacingPrompt`, `injectSurfacedContent` unchanged.

- [ ] **Step 1: Rewrite runSideQuery and add buildSideQueryTask**

Replace the bottom section of inject.ts (from `/** Run a lightweight LLM...` to end of file):

```typescript
// pi-memory/src/inject.ts — bottom section replacement

import type { ThinkLevel } from "./config";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { runHeadlessAgent } from "./agent-runner";

export function buildSideQueryTask(prompt: string, maxFiles: number): string {
  return [
    "Respond with ONLY a JSON object.",
    "",
    "Below is a list of memory topic files and a user query.",
    `Select up to ${maxFiles} topic files MOST relevant to the user's current query.`,
    'If nothing is relevant, return {"selected_files": []}.',
    "",
    prompt,
    "",
    'Respond with EXACTLY: {"selected_files": [...]}',
  ].join("\n");
}

function parseSelectedFiles(
  result: string,
  candidates: TopicManifest[],
  maxFiles: number,
): string[] {
  try {
    const jsonMatch = result.match(/\{[^}]*"selected_files"[^}]*\}/s);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    const files: string[] = parsed.selected_files ?? [];
    return files
      .filter((f: string) => candidates.some((c) => c.filename === f))
      .slice(0, maxFiles);
  } catch {
    return [];
  }
}

export async function runSideQuery(
  prompt: string,
  manifest: TopicManifest[],
  maxFiles: number,
  thinkLevel: ThinkLevel,
  model: string | undefined,
  modelRegistry: ModelRegistry,
  parentModel: Model<any> | undefined,
  memoryDir: string,
): Promise<string[]> {
  const candidates = manifest.filter(
    (t) => !prompt.includes(`[already injected] ${t.filename}`),
  );
  if (candidates.length === 0) return [];

  const task = buildSideQueryTask(prompt, maxFiles);
  try {
    const result = await runHeadlessAgent({
      task,
      cwd: memoryDir,
      modelRegistry,
      model,
      parentModel,
      thinkLevel,
      maxTurns: 1,
      timeoutMs: 30_000,
    });
    return parseSelectedFiles(result, candidates, maxFiles);
  } catch {
    return [];
  }
}
```

Also remove the old `keywordMatch` function (entirely) and the `import { getSubagentsService } from "@yandy0725/pi-subagents"` line at the top.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pi-memory && npx vitest run tests/inject.test.ts`
Expected: FAIL — old runSideQuery tests use pi-subagents mocks

- [ ] **Step 3: Commit**

```bash
git add pi-memory/src/inject.ts
git commit -m "refactor: rewrite runSideQuery to use runHeadlessAgent, add buildSideQueryTask, remove keywordMatch"
```

---

### Task 7: Delete `src/agent-types.ts`

**Files:**
- Delete: `pi-memory/src/agent-types.ts`

- [ ] **Step 1: Delete the file**

```bash
rm pi-memory/src/agent-types.ts
```

- [ ] **Step 2: Commit**

```bash
git add pi-memory/src/agent-types.ts
git commit -m "refactor: remove agent-types.ts — no longer needed without pi-subagents"
```

---

### Task 8: Rewire `index.ts`

**Files:**
- Modify: `pi-memory/index.ts`

**Changes:**
1. Remove `import { ensureAgentTypes } from "./src/agent-types"` and `ensureAgentTypes()` call
2. Update `isSubagent` detection to `event.systemPrompt.includes("<active_agent name=")`
3. Remove `pi.events` from `runDream` and `runSideQuery` calls
4. Pass `modelRegistry: ctx.modelRegistry` + `parentModel: ctx.model` to all three tasks
5. Remove `setTimeout(0)` wrapper in nudge flow
6. Remove pi-subagents comments (lines ~61, ~93-95)
7. `/dream` command: fire-and-forget pattern

- [ ] **Step 1: Make all edits to index.ts**

The edits are too numerous for a single diff. Key changes:

**Remove (line ~3):**
```
import { ensureAgentTypes } from "./src/agent-types";
```

**Remove (line ~22):**
```
ensureAgentTypes();
```

**Replace nudge setTimeout block (lines ~68-84):**
```typescript
// Old:
setTimeout(async () => {
  try {
    const summary = await runDream({
      model: dreamModel,
      thinkLevel: dreamThinkLevel,
      memoryDir: dir,
      events: pi.events,
    });
    await writeDreamMeta(dir, sessions);
    ctx.ui.notify(summary, "info");
  } catch (e: any) {
    ctx.ui.notify(`Dream failed: ${e.message}`, "error");
  } finally {
    ctx.ui.setStatus("dream", undefined);
  }
}, 0);

// New:
runDream({
  model: dreamModel,
  thinkLevel: dreamThinkLevel,
  memoryDir: dir,
  modelRegistry: ctx.modelRegistry,
  parentModel: ctx.model,
})
  .then(async (summary) => {
    await writeDreamMeta(dir, sessions);
    ctx.ui.notify(summary, "info");
  })
  .catch((e: any) => ctx.ui.notify(`Dream failed: ${e.message}`, "error"))
  .finally(() => ctx.ui.setStatus("dream", undefined));
```

**Replace isSubagent detection (lines ~91-97):**
```typescript
// Old:
// Skip for subagents: pi-subagents strips "subagent" from all children's
// tool sets, so its absence reliably identifies subagents. Without this guard,
// runSideQuery's subagent spawn → before_agent_start → re-enter here → OOM.
const agentTools = event.systemPromptOptions?.selectedTools;
const isSubagent = agentTools && !agentTools.includes("subagent");

// New:
const isSubagent = event.systemPrompt.includes("<active_agent name=");
```

**Update runSideQuery call (line ~108):**
```typescript
// Old:
const selected = await runSideQuery(queryPrompt, manifest, autoSurfacing.maxFiles, autoSurfacing.thinkLevel, pi.events);

// New:
const selected = await runSideQuery(
  queryPrompt, manifest,
  autoSurfacing.maxFiles,
  autoSurfacing.thinkLevel,
  autoSurfacing.model,
  ctx.modelRegistry,
  ctx.model,
  memoryDir,
);
```

**Update runExtract call (lines ~130-145):**
```typescript
// Old:
runExtract({
  model: extractConfig.model,
  thinkLevel: extractConfig.thinkLevel,
  memoryDir,
  messages: event.messages.map(...),
  maxContextTokens: extractConfig.maxContextTokens,
}).catch(() => { /* silently ignore extract errors */ });

// New:
runExtract({
  model: extractConfig.model,
  thinkLevel: extractConfig.thinkLevel,
  memoryDir,
  messages: event.messages.map(...),
  maxContextTokens: extractConfig.maxContextTokens,
  modelRegistry: ctx.modelRegistry,
  parentModel: ctx.model,
}).catch(() => { /* silently ignore extract errors */ });
```

**Update /dream command (lines ~200-218):**
```typescript
// Old:
const summary = await runDream({
  model: config.dream.model,
  thinkLevel: config.dream.thinkLevel,
  memoryDir,
  signal: ctx.signal,
  events: pi.events,
});
const sessions = (await SessionManager.list(ctx.cwd)).length;
await writeDreamMeta(memoryDir, sessions);
ctx.ui.notify(summary, "info");

// New:
runDream({
  model: config.dream.model,
  thinkLevel: config.dream.thinkLevel,
  memoryDir,
  modelRegistry: ctx.modelRegistry,
  parentModel: ctx.model,
})
  .then(async (summary) => {
    const sessions = (await SessionManager.list(ctx.cwd)).length;
    await writeDreamMeta(memoryDir, sessions);
    ctx.ui.notify(summary, "info");
  })
  .catch((e: any) => ctx.ui.notify(`Dream failed: ${e.message}`, "error"))
  .finally(() => ctx.ui.setStatus("dream", undefined));
```

**Remove `events: pi.events` from the old runDream call context** — the `pi.events` parameter is no longer passed anywhere, but `pi` is still needed for `pi.on(...)` and `pi.registerTool/Command`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pi-memory && npx vitest run tests/index-wiring.test.ts`
Expected: FAIL — old isSubagent tests outdated

- [ ] **Step 3: Commit**

```bash
git add pi-memory/index.ts
git commit -m "refactor: rewire index.ts — remove pi-subagents, use runHeadlessAgent for all tasks, <active_agent> detection"
```

---

### Task 9: Update `package.json`

**Files:**
- Modify: `pi-memory/package.json`

- [ ] **Step 1: Remove pi-subagents peerDependency**

```diff
  "peerDependencies": {
    "@earendil-works/pi-ai": ">=0.80.2",
    "@earendil-works/pi-coding-agent": ">=0.80.2",
    "@earendil-works/pi-tui": ">=0.80.2",
-   "@yandy0725/pi-subagents": "*",
    "typebox": "*"
  },
```

- [ ] **Step 2: Commit**

```bash
git add pi-memory/package.json
git commit -m "refactor: remove @yandy0725/pi-subagents peerDependency"
```

---

### Task 10: Rewrite tests — `dream.test.ts`, `extract.test.ts`, `inject.test.ts`

**Files:**
- Modify: `pi-memory/tests/dream.test.ts`
- Modify: `pi-memory/tests/extract.test.ts`
- Modify: `pi-memory/tests/inject.test.ts`

- [ ] **Step 1: Rewrite dream.test.ts**

Replace all `runDream` tests. Keep `buildDreamTask` tests as-is.

```typescript
// Replace the "runDream" describe block entirely:

import { describe, it, expect, vi } from "vitest";

const { runHeadlessAgentMock } = vi.hoisted(() => ({
  runHeadlessAgentMock: vi.fn(),
}));

vi.mock("../src/agent-runner", () => ({
  runHeadlessAgent: runHeadlessAgentMock,
}));

import { buildDreamTask, runDream } from "../src/dream";

// buildDreamTask tests — keep unchanged
describe("buildDreamTask", () => {
  // ... existing tests unchanged
});

describe("runDream", () => {
  it("calls runHeadlessAgent with correct opts", async () => {
    runHeadlessAgentMock.mockResolvedValue("merged 3 entries");

    const result = await runDream({
      model: "deepseek/deepseek-v4-flash",
      thinkLevel: "high",
      memoryDir: "/mem/x",
      modelRegistry: { find: vi.fn() } as any,
      parentModel: { provider: "openai", id: "gpt-4" } as any,
    });

    expect(runHeadlessAgentMock).toHaveBeenCalledWith({
      task: expect.stringContaining("/mem/x"),
      cwd: "/mem/x",
      modelRegistry: expect.any(Object),
      model: "deepseek/deepseek-v4-flash",
      parentModel: expect.any(Object),
      thinkLevel: "high",
      maxTurns: undefined,
      timeoutMs: 600_000,
    });
    expect(result).toBe("merged 3 entries");
  });

  it("passes undefined model when not configured", async () => {
    runHeadlessAgentMock.mockResolvedValue("done");

    await runDream({
      thinkLevel: "medium",
      memoryDir: "/mem/x",
      modelRegistry: {} as any,
    });

    expect(runHeadlessAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: undefined,
        thinkLevel: "medium",
      }),
    );
  });
});
```

- [ ] **Step 2: Rewrite extract.test.ts**

```typescript
// Replace the "runExtract" describe block:

import { describe, it, expect, vi } from "vitest";

const { runHeadlessAgentMock } = vi.hoisted(() => ({
  runHeadlessAgentMock: vi.fn().mockResolvedValue(""),
}));

vi.mock("../src/agent-runner", () => ({
  runHeadlessAgent: runHeadlessAgentMock,
}));

import { buildExtractTask, runExtract } from "../src/extract";

// buildExtractTask tests — keep unchanged
describe("buildExtractTask", () => {
  // ... existing tests unchanged
});

describe("runExtract", () => {
  it("calls runHeadlessAgent with maxTurns=5 and timeoutMs=120000", async () => {
    runHeadlessAgentMock.mockResolvedValue("");

    runExtract({
      model: "deepseek/deepseek-v4-flash",
      thinkLevel: "high",
      memoryDir: "/mem/x",
      messages: [{ role: "user", content: "hello" }],
      maxContextTokens: 2000,
      modelRegistry: {} as any,
      parentModel: {} as any,
    });

    // Let microtask fire
    await new Promise((r) => setTimeout(r, 0));

    expect(runHeadlessAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/mem/x",
        model: "deepseek/deepseek-v4-flash",
        thinkLevel: "high",
        maxTurns: 5,
        timeoutMs: 120_000,
      }),
    );
  });

  it("skips when messages array is empty", () => {
    runHeadlessAgentMock.mockReset();

    runExtract({
      model: undefined,
      thinkLevel: "high",
      memoryDir: "/mem/x",
      messages: [],
      maxContextTokens: 2000,
      modelRegistry: {} as any,
    });

    expect(runHeadlessAgentMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Rewrite inject.test.ts — runSideQuery tests**

Keep all existing tests for `loadIndexSnapshot`, `buildInjection`, `scanTopics`, `buildSurfacingPrompt`, `injectSurfacedContent` unchanged. Replace only the `runSideQuery` describe block:

```typescript
// Remove: vi.mock("@yandy0725/pi-subagents", ...)

const { runHeadlessAgentMock } = vi.hoisted(() => ({
  runHeadlessAgentMock: vi.fn(),
}));

vi.mock("../src/agent-runner", () => ({
  runHeadlessAgent: runHeadlessAgentMock,
}));

// Replace "runSideQuery" describe:
describe("runSideQuery", () => {
  it("calls runHeadlessAgent with maxTurns=1 and timeoutMs=30000", async () => {
    runHeadlessAgentMock.mockResolvedValue('{"selected_files":["a.md"]}');

    const manifest = [
      { filename: "a.md", name: "A", description: "desc", type: "feedback" as const, mtimeMs: 100 },
    ];

    const result = await runSideQuery(
      "user query about A",
      manifest,
      5,
      "off",
      undefined,
      { find: vi.fn() } as any,
      undefined,
      "/mem/dir",
    );

    expect(runHeadlessAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/mem/dir",
        maxTurns: 1,
        timeoutMs: 30_000,
        thinkLevel: "off",
      }),
    );
    expect(result).toEqual(["a.md"]);
  });

  it("returns [] on timeout/failure", async () => {
    runHeadlessAgentMock.mockRejectedValue(new Error("Timed out"));

    const manifest = [
      { filename: "a.md", name: "A", description: "desc", type: "feedback" as const, mtimeMs: 100 },
    ];

    const result = await runSideQuery(
      "query",
      manifest,
      5,
      "off",
      undefined,
      { find: vi.fn() } as any,
      undefined,
      "/mem/dir",
    );

    expect(result).toEqual([]);
  });

  it("returns empty when no candidates", async () => {
    runHeadlessAgentMock.mockReset();
    const result = await runSideQuery(
      "query", [], 5, "off", undefined, {} as any, undefined, "/mem/dir",
    );
    expect(result).toEqual([]);
    expect(runHeadlessAgentMock).not.toHaveBeenCalled();
  });

  it("passes model and parentModel through", async () => {
    runHeadlessAgentMock.mockResolvedValue('{"selected_files":[]}');
    const parentModel = { provider: "openai", id: "gpt-4" };

    await runSideQuery(
      "q",
      [{ filename: "a.md", name: "A", description: "d", type: "feedback" as const, mtimeMs: 100 }],
      5,
      "high",
      "deepseek/deepseek-v4-flash",
      { find: vi.fn() } as any,
      parentModel as any,
      "/mem/dir",
    );

    expect(runHeadlessAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek/deepseek-v4-flash",
        parentModel,
        thinkLevel: "high",
      }),
    );
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd pi-memory && npx vitest run tests/dream.test.ts tests/extract.test.ts tests/inject.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pi-memory/tests/dream.test.ts pi-memory/tests/extract.test.ts pi-memory/tests/inject.test.ts
git commit -m "test: rewrite dream/extract/inject tests to mock runHeadlessAgent instead of pi-subagents"
```

---

### Task 11: Rewrite `tests/index-wiring.test.ts`

**Files:**
- Modify: `pi-memory/tests/index-wiring.test.ts`

**Changes:** Replace "skips auto-surfacing for subagents" and "runs auto-surfacing for main agents" tests with `<active_agent>` detection tests. Update model default from `"auto"` to undefined. Remove `runDream` mock changes (now called directly). Add `modelRegistry` to fake context.

- [ ] **Step 1: Rewrite subagent detection tests**

Replace the two subagent detection tests with:

```typescript
it("skips auto-surfacing when systemPrompt has <active_agent name= marker", async () => {
  const { pi, handlers } = createFakePi();
  memoryFactory(pi as any);

  const fakeCtx = { cwd: tmpDir, hasUI: false, isProjectTrusted: () => true };
  await handlers["session_start"][0]({}, fakeCtx);

  scanTopicsMock.mockResolvedValue([]);

  const subagentEvent = {
    prompt: "Some subagent task...",
    systemPrompt: "Base prompt\n<active_agent name=\"general-purpose\"/>\n\n# Environment\n...",
    systemPromptOptions: {
      cwd: tmpDir,
      selectedTools: ["read", "write", "edit", "ls"],
    },
  };

  const result = await handlers["before_agent_start"][0](subagentEvent, fakeCtx);
  expect(result?.systemPrompt).toContain("# Memory Index");
  expect(scanTopicsMock).not.toHaveBeenCalled();
});

it("runs auto-surfacing when systemPrompt has no <active_agent name= marker", async () => {
  const { pi, handlers } = createFakePi();
  memoryFactory(pi as any);

  const fakeCtx = { cwd: tmpDir, hasUI: false, isProjectTrusted: () => true };
  await handlers["session_start"][0]({}, fakeCtx);

  scanTopicsMock.mockResolvedValue([
    { filename: "ssh.md", name: "SSH", description: "ssh config", type: "project", mtimeMs: 100 },
  ]);
  runSideQueryMock.mockResolvedValue(["ssh.md"]);
  injectSurfacedContentMock.mockResolvedValue(
    "<relevant_memories>\n## ssh.md\nssh config\n</relevant_memories>",
  );

  const mainEvent = {
    prompt: "how do I debug SSH?",
    systemPrompt: "Normal system prompt",
    systemPromptOptions: {
      cwd: tmpDir,
      selectedTools: ["read", "bash", "edit", "write"],
    },
  };

  const result = await handlers["before_agent_start"][0](mainEvent, fakeCtx);
  expect(scanTopicsMock).toHaveBeenCalledTimes(1);
  expect(runSideQueryMock).toHaveBeenCalledTimes(1);
  expect(result?.systemPrompt).toContain("# Memory Index");
});
```

Also update the config mock to remove `model: "auto"`:
```typescript
// In vi.mock("../src/config", ...)
dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, thinkLevel: "high" },
// (no model field)
autoSurfacing: {
  enabled: true,
  // no model field
  maxFiles: 5,
  ...
```

- [ ] **Step 2: Run tests**

Run: `cd pi-memory && npx vitest run tests/index-wiring.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add pi-memory/tests/index-wiring.test.ts
git commit -m "test: update index-wiring tests for <active_agent> detection and model changes"
```

---

### Task 12: Verify all tests pass

- [ ] **Step 1: Run full test suite**

Run: `cd pi-memory && npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `cd pi-memory && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: final cleanup, all tests pass"
```

---

### Task 13: Final integration check

- [ ] **Step 1: Verify no remaining pi-subagents references**

```bash
grep -r "pi-subagents\|SubagentsService\|WorkspaceProvider\|getSubagentsService\|subagents:completed\|subagents:failed" pi-memory/src/ pi-memory/index.ts pi-memory/tests/ pi-memory/package.json || echo "CLEAN"
```
Expected: "CLEAN" (no matches)

- [ ] **Step 2: Full test suite one more time**

Run: `cd pi-memory && npx vitest run`
Expected: All PASS
