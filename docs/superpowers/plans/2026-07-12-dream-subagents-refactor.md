# Dream Refactor: Use pi-subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual `createAgentSession` in `dream.ts` with `SubagentsService` from `pi-subagents`, and upgrade dream nudge from passive toast to interactive confirm dialog.

**Architecture:** `runDream()` uses `SubagentsService.spawn("general-purpose", task)` + `WorkspaceProvider` (cwd → memoryDir) and listens to `subagents:completed`/`subagents:failed` events via a promise. Nudge and `/dream` command share the same `runDream()`.

**Tech Stack:** TypeScript, vitest, `@earendil-works/pi-coding-agent`, `@yandy0725/pi-subagents`

## Global Constraints

- `@yandy0725/pi-subagents` as peerDependency
- `dream.model === "auto"` → don't pass model to spawn (child inherits parent)
- `dream.model === "provider/id"` → pass as `model` option to spawn
- Nudge uses `ctx.ui.confirm()` instead of `ctx.ui.notify()`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `pi-memory/package.json` | Add `@yandy0725/pi-subagents` peerDependency |
| `pi-memory/src/nudge.ts` | Add `sessions`/`newEntries` to `shouldNudge()` return |
| `pi-memory/src/dream.ts` | New `runDream()` using SubagentsService; merge DREAM_SYSTEM_PROMPT into buildDreamTask(); remove resolveDreamModel/extractSummary |
| `pi-memory/index.ts` | Nudge: confirm → runDream; Dream handler: simplified |
| `pi-memory/tests/nudge.test.ts` | Update assertions for new return fields |
| `pi-memory/tests/dream.test.ts` | Rewrite for SubagentsService-based runDream |
| `pi-memory/tests/index-wiring.test.ts` | Update dream mock signature |

---

### Task 1: Add pi-subagents dependency and update nudge return type

**Files:**
- Modify: `pi-memory/package.json`
- Modify: `pi-memory/src/nudge.ts:65-80` (shouldNudge return statements)
- Modify: `pi-memory/tests/nudge.test.ts:38-48` (shouldNudge test assertions)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `shouldNudge()` now returns `{ nudge: boolean; message: string; sessions: number; newEntries: number }`

- [ ] **Step 1: Add peerDependency to package.json**

```bash
# Edit pi-memory/package.json, add to peerDependencies:
"@yandy0725/pi-subagents": "*"
```

- [ ] **Step 2: Update shouldNudge return statements in nudge.ts**

In `pi-memory/src/nudge.ts`, change both return paths in `shouldNudge()`:
- The `nudge: true` path: add `sessions, newEntries` to return object
- The final `nudge: false` path: add `sessions: 0, newEntries: 0`

```typescript
// Line ~76: nudge: true return
return { nudge: true, message: formatNudge(sessions, newEntries), sessions, newEntries };

// Line ~81: nudge: false return  
return { nudge: false, message: "", sessions: 0, newEntries: 0 };
```

- [ ] **Step 3: Update nudge test assertions**

In `pi-memory/tests/nudge.test.ts`, update the `shouldNudge` tests to destructure `sessions` and `newEntries`:

```typescript
// In "nudges when enough sessions passed since last dream"
const r = await shouldNudge(dir, { dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, model: "auto" } } as any, dir);
expect(r.nudge).toBe(true);
expect(r.sessions).toBe(8);
expect(r.newEntries).toBe(6); // 8 sessions - 2 at last dream

// In "does not nudge when recent dream"
const r = await shouldNudge(dir, { dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, model: "auto" } } as any, dir);
expect(r.nudge).toBe(false);
expect(r.sessions).toBeGreaterThanOrEqual(0);
expect(r.newEntries).toBeGreaterThanOrEqual(0);
```

- [ ] **Step 4: Run nudge tests**

Run: `cd pi-memory && npx vitest run tests/nudge.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add pi-memory/package.json pi-memory/src/nudge.ts pi-memory/tests/nudge.test.ts
git commit -m "feat(memory): add pi-subagents peer dep, extend shouldNudge return"
```

---

### Task 2: Rewrite runDream() in dream.ts

**Files:**
- Modify: `pi-memory/src/dream.ts` (entire file rewrite)
- Modify: `pi-memory/tests/dream.test.ts` (entire file rewrite)

**Interfaces:**
- Consumes: `getSubagentsService` from `@yandy0725/pi-subagents`, `SubagentsService` type, `WorkspaceProvider` type
- Produces: `runDream(opts: RunDreamOpts): Promise<string>`, `buildDreamTask(memoryDir: string, maxLines: number): string`

- [ ] **Step 1: Write failing tests for new runDream**

Rewrite `pi-memory/tests/dream.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildDreamTask, runDream } from "../src/dream";
import { access } from "node:fs/promises";

describe("buildDreamTask", () => {
  it("includes memory dir + consolidation instructions + line limit + rules from DREAM_SYSTEM_PROMPT", () => {
    const task = buildDreamTask("/mem/abc123", 200);
    expect(task).toContain("/mem/abc123");
    expect(task).toContain("200");
    expect(task).toContain("## Entry Title");
    expect(task).toContain("not necessarily every entry");
    // Rules merged from DREAM_SYSTEM_PROMPT
    expect(task).toMatch(/deduplicat|consolidat/i);
    expect(task).toContain("self-descriptive");
    expect(task).toContain("MEMORY.md index");
  });
});

describe("runDream", () => {
  it("spawns general-purpose subagent and resolves with result on completion", async () => {
    const completedHandlers: Array<(data: any) => void> = [];
    const failedHandlers: Array<(data: any) => void> = [];

    const fakeService = {
      spawn: vi.fn().mockReturnValue("agent-dream-1"),
      getRecord: vi.fn().mockReturnValue({ result: "merged 3 entries" }),
      registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
    };
    const events = {
      on: vi.fn((channel: string, handler: (data: any) => void) => {
        if (channel === "subagents:completed") completedHandlers.push(handler);
        if (channel === "subagents:failed") failedHandlers.push(handler);
        return () => {}; // unsubscribe stub
      }),
    };

    const promise = runDream({
      model: "auto",
      memoryDir: "/mem/x",
      service: fakeService as any,
      events: events as any,
    });

    // Verify spawn called
    expect(fakeService.registerWorkspaceProvider).toHaveBeenCalled();
    expect(fakeService.spawn).toHaveBeenCalledWith(
      "general-purpose",
      expect.stringContaining("/mem/x"),
      {},
    );

    // Simulate completed event
    completedHandlers[0]({ id: "agent-dream-1" });

    const summary = await promise;
    expect(summary).toBe("merged 3 entries");
  });

  it("rejects when subagent fails", async () => {
    const failedHandlers: Array<(data: any) => void> = [];

    const fakeService = {
      spawn: vi.fn().mockReturnValue("agent-dream-2"),
      getRecord: vi.fn().mockReturnValue({ error: "something broke" }),
      registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
    };
    const events = {
      on: vi.fn((channel: string, handler: (data: any) => void) => {
        if (channel === "subagents:failed") failedHandlers.push(handler);
        return () => {};
      }),
    };

    const promise = runDream({
      model: "auto",
      memoryDir: "/mem/x",
      service: fakeService as any,
      events: events as any,
    });

    // Simulate failed event
    failedHandlers[0]({ id: "agent-dream-2", error: "something broke" });

    await expect(promise).rejects.toThrow("something broke");
  });

  it("passes model to spawn when not auto", async () => {
    const fakeService = {
      spawn: vi.fn().mockReturnValue("agent-dream-3"),
      getRecord: vi.fn().mockReturnValue({}),
      registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
    };
    const events = {
      on: vi.fn(() => () => {}),
    };

    // Fire completion immediately after spawn via microtask
    setTimeout(() => {
      const handler = (events.on as any).mock.calls.find(
        (c: any) => c[0] === "subagents:completed"
      )?.[1];
      handler?.({ id: "agent-dream-3" });
    }, 0);

    await runDream({
      model: "deepseek/deepseek-v4-flash",
      memoryDir: "/mem/x",
      service: fakeService as any,
      events: events as any,
    });

    expect(fakeService.spawn).toHaveBeenCalledWith(
      "general-purpose",
      expect.any(String),
      { model: "deepseek/deepseek-v4-flash" },
    );
  });

  it("aborts on signal", async () => {
    const fakeService = {
      spawn: vi.fn().mockReturnValue("agent-dream-4"),
      getRecord: vi.fn().mockReturnValue({}),
      registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
    };
    const events = { on: vi.fn(() => () => {}) };
    const controller = new AbortController();

    const promise = runDream({
      model: "auto",
      memoryDir: "/mem/x",
      service: fakeService as any,
      events: events as any,
      signal: controller.signal,
    });

    controller.abort();
    expect(fakeService.abort).toHaveBeenCalledWith("agent-dream-4");

    // Trigger failed after abort to resolve the promise
    const handler = (events.on as any).mock.calls.find(
      (c: any) => c[0] === "subagents:failed"
    )?.[1];
    handler?.({ id: "agent-dream-4", error: "aborted" });
    await expect(promise).rejects.toThrow("aborted");
  });

  it("throws when service is undefined", async () => {
    await expect(
      runDream({ model: "auto", memoryDir: "/mem/x" } as any)
    ).rejects.toThrow("pi-subagents not available");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pi-memory && npx vitest run tests/dream.test.ts`
Expected: FAIL (runDream not implemented with new signature)

- [ ] **Step 3: Rewrite dream.ts with new implementation**

Write `pi-memory/src/dream.ts`:

```typescript
import { getSubagentsService, type SubagentsService } from "@yandy0725/pi-subagents";
import type { WorkspaceProvider } from "@yandy0725/pi-subagents";
import { access } from "node:fs/promises";

export function buildDreamTask(memoryDir: string, maxLines: number): string {
  return `You are a memory consolidation agent. Your job: read all memory files in the given directory, consolidate entries within each topic (merge duplicates, resolve contradictions, update outdated info), and rebuild the MEMORY.md index to be concise and accurate.

Task: Consolidate the memory files under ${memoryDir}. Read every .md file (including MEMORY.md), then:
1. Deduplicate entries within each topic that say the same thing.
2. Merge contradictory or overlapping entries into one accurate entry.
3. Update outdated information.
4. Move entries to more appropriate topic files when needed.
5. Rebuild MEMORY.md (max ${maxLines} lines): - [Entry Title](topic.md) per entry you deem valuable (not necessarily every entry). Entries use ## Entry Title format.

Rules:
- Each topic file contains entries as \`## Entry Title\` blocks.
- Only modify files under the given directory. Never touch anything else.
- Rebuild MEMORY.md index: list entries you deem valuable. Each line: - [Entry Title](topic.md). Accuracy matters more than completeness.
- CRITICAL for entry titles: Only the MEMORY.md index is injected into future coding sessions (topic file content is NOT seen by the coding agent). Rewrite every entry title to be self-contained and descriptive — like "always use uv instead of pip for Python" instead of just "python tools". The title alone must tell the model what the entry is about.
- When done, output a concise summary of changes (merged N, removed N, moved N, updated N).`;
}

export interface RunDreamOpts {
  model: string;
  memoryDir: string;
  signal?: AbortSignal;
  events?: { on(channel: string, handler: (data: any) => void): () => void };
  service?: SubagentsService;
}

export async function runDream(opts: RunDreamOpts): Promise<string> {
  const service = opts.service ?? getSubagentsService();
  if (!service) throw new Error("pi-subagents not available — install @yandy0725/pi-subagents");

  const events = opts.events;
  if (!events) throw new Error("events required for dream — pass pi.events");

  const model = opts.model === "auto" ? undefined : opts.model;
  const task = buildDreamTask(opts.memoryDir, 200);

  // Register workspace provider so the subagent runs in memoryDir
  const provider: WorkspaceProvider = {
    async prepare(_ctx) {
      await access(opts.memoryDir).catch(() => {
        throw new Error(`Memory directory not found: ${opts.memoryDir}`);
      });
      return {
        cwd: opts.memoryDir,
        dispose: () => undefined,
      };
    },
  };
  const unregister = service.registerWorkspaceProvider(provider);

  // Spawn the dream subagent
  const agentId = service.spawn(
    "general-purpose",
    task,
    model ? { model } : {},
  );

  // Wait for completion/failure via events
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        unsubCompleted();
        unsubFailed();
        unregister();
        opts.signal?.removeEventListener("abort", onAbort);
      };

      const onCompleted = (data: { id: string }) => {
        if (data.id !== agentId) return;
        cleanup();
        const record = service.getRecord(agentId);
        resolve(record?.result ?? "Dream completed.");
      };

      const onFailed = (data: { id: string; error?: string }) => {
        if (data.id !== agentId) return;
        cleanup();
        reject(new Error(data.error ?? "Dream agent failed"));
      };

      const onAbort = () => {
        service.abort(agentId);
      };

      const unsubCompleted = events.on("subagents:completed", onCompleted);
      const unsubFailed = events.on("subagents:failed", onFailed);

      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
  } catch (e) {
    // Ensure cleanup on rejection
    unregister();
    throw e;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pi-memory && npx vitest run tests/dream.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add pi-memory/src/dream.ts pi-memory/tests/dream.test.ts
git commit -m "feat(memory): rewrite runDream using SubagentsService + WorkspaceProvider"
```

---

### Task 3: Update index.ts — nudge confirm + dream handler

**Files:**
- Modify: `pi-memory/index.ts`
- Modify: `pi-memory/tests/index-wiring.test.ts`

**Interfaces:**
- Consumes: `runDream` from `./src/dream` (new signature), `shouldNudge` from `./src/nudge` (new return fields)
- Produces: No new exports — internal wiring change

- [ ] **Step 1: Update wiring test mocks**

In `pi-memory/tests/index-wiring.test.ts`, update the dream mock to match new signature and add a mock for pi-subagents:

```typescript
// Replace the dream mock:
vi.mock("../src/dream", () => ({
  runDream: vi.fn().mockResolvedValue("done"),
  buildDreamTask: vi.fn().mockReturnValue("dream task"),
}));

// Update the nudge mock:
vi.mock("../src/nudge", () => ({
  shouldNudge: vi.fn().mockResolvedValue({ nudge: false, message: "", sessions: 0, newEntries: 0 }),
  writeDreamMeta: vi.fn().mockResolvedValue(undefined),
  readDreamMeta: vi.fn().mockResolvedValue({ lastDreamAt: null }),
}));
```

- [ ] **Step 2: Run wiring tests to verify they fail**

Run: `cd pi-memory && npx vitest run tests/index-wiring.test.ts`
Expected: FAIL (index.ts still has old imports)

- [ ] **Step 3: Update index.ts**

Update `pi-memory/index.ts`. Key changes:

**Imports** — remove `resolveDreamModel`, keep only `runDream`:

```typescript
// Old:
import { runDream, resolveDreamModel } from "./src/dream";

// New:
import { runDream } from "./src/dream";
```

**Nudge section** — replace `ctx.ui.notify` with `ctx.ui.confirm` + runDream:

```typescript
// Old (lines ~36-39):
if (ctx.hasUI) {
    const { nudge, message } = await shouldNudge(memoryDir, config, ctx.cwd);
    if (nudge) ctx.ui.notify(message, "info");
}

// New:
if (ctx.hasUI) {
    const { nudge, message, sessions } = await shouldNudge(memoryDir, config, ctx.cwd);
    if (nudge) {
        const ok = await ctx.ui.confirm(
            "Memory Consolidation",
            `${message}\n\nConsolidate memory files now?`,
        );
        if (ok) {
            ctx.ui.setStatus("dream", "Consolidating memory...");
            try {
                const summary = await runDream({
                    model: config.dream.model,
                    memoryDir,
                    events: pi.events,
                });
                await writeDreamMeta(memoryDir, sessions);
                ctx.ui.notify(summary, "info");
            } catch (e: any) {
                ctx.ui.notify(`Dream failed: ${e.message}`, "error");
            } finally {
                ctx.ui.setStatus("dream", undefined);
            }
        }
    }
}
```

**Dream command handler** — remove `resolveDreamModel`, simplify:

```typescript
// Old (lines ~51-72):
const model = resolveDreamModel(config, ctx);
if (!model) {
    ctx.ui.notify("No model available for dream (check dream.model config / API key).", "error");
    return;
}
ctx.ui.setStatus("dream", "Consolidating memory...");
try {
    const summary = await runDream({ model, memoryDir, cwd: memoryDir, signal: ctx.signal });
    // ...

// New:
ctx.ui.setStatus("dream", "Consolidating memory...");
try {
    const summary = await runDream({
        model: config.dream.model,
        memoryDir,
        signal: ctx.signal,
        events: pi.events,
    });
    const sessions = (await SessionManager.list(ctx.cwd)).length;
    await writeDreamMeta(memoryDir, sessions);
    ctx.ui.notify(summary, "info");
} catch (e: any) {
    ctx.ui.notify(`Dream failed: ${e.message}`, "error");
} finally {
    ctx.ui.setStatus("dream", undefined);
}
```

- [ ] **Step 4: Run wiring tests**

Run: `cd pi-memory && npx vitest run tests/index-wiring.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run all tests**

Run: `cd pi-memory && npx vitest run`
Expected: ALL PASS (all test files)

- [ ] **Step 6: Commit**

```bash
git add pi-memory/index.ts pi-memory/tests/index-wiring.test.ts
git commit -m "feat(memory): nudge uses confirm, dream handler uses new runDream signature"
```
