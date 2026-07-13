# Dream Refactor: Use pi-subagents for Consolidation

> **Goal:** Replace manual `createAgentSession` in `dream.ts` with `SubagentsService` from `pi-subagents`, and upgrade the dream nudge from passive toast to interactive confirm dialog.

**Status:** Draft — awaiting user review

---

## 1. Motivation

`pi-memory`'s `/dream` command currently constructs a headless agent session by hand: `createAgentSession` + `DefaultResourceLoader` + `AuthStorage` + `ModelRegistry` + `SessionManager`. This is ~70 lines of assembly code that duplicates infrastructure already provided by `pi-subagents`. Since `pi-memory` and `pi-subagents` are sibling packages in the same monorepo, using the subagent service yields:

- **Less code**: drops ~50+ lines of session assembly
- **Consistent behavior**: subagent lifecycle (recursion guard, concurrency, turn limits, cleanup) is handled by `pi-subagents`
- **Loose coupling**: `pi-memory` consumes the typed `SubagentsService` API, not raw `createAgentSession`

## 2. Architecture

### 2.1 Dependency

Add `@yandy0725/pi-subagents` as a `peerDependency` in `pi-memory/package.json`.

### 2.2 Dream via SubagentsService

**Current flow** (`src/dream.ts`):
1. Build `DefaultResourceLoader` / `AuthStorage` / `ModelRegistry`
2. Call `createAgentSession({ model, tools, cwd, ... })`
3. Subscribe to session events, call `session.prompt(dreamTask)`
4. Extract summary from last assistant message
5. Dispose session

**New flow** (`src/dream.ts`):
1. Resolve model: `dream.model === "auto" ? undefined : dream.model`
2. Register a `WorkspaceProvider` that returns `{ cwd: memoryDir, dispose: () => undefined }` (verify memoryDir exists in `prepare()`)
3. Call `service.spawn("general-purpose", buildDreamTask(memoryDir), { model })` → get `agentId`
4. Subscribe to `subagents:completed` event; filter `eventData.id === agentId`; read `service.getRecord(agentId).result`
5. Subscribe to `subagents:failed` event; filter same agentId for error handling
6. After completion/failure, unregister workspace provider
7. Return result summary (from record.result or error from record.error)

**Why `general-purpose` type**: It has all built-in tools (read, edit, write, bash, grep, find, ls) and `promptMode: "append"`, so the parent system prompt (which already injects `MEMORY.md` at `session_start`) is inherited. The dream task instructions are passed as the agent prompt.

No `foreground` option is passed — the dream subagent runs as a background subagent (default), subject to the concurrency limiter. The command handler uses events to await completion.

**Model resolution**:
- `dream.model === "auto"` → don't pass `model` option to `spawn()` — subagent inherits parent model
- `dream.model === "provider/id"` → pass `model: "provider/id"` — subagent's built-in `resolveModel()` handles registry lookup
- `resolveDreamModel()` is no longer needed — replaced by a simple `model`-or-`undefined` decision

### 2.3 Dream Nudge → Confirm

**Current**: `ctx.ui.notify(message, "info")` — passive toast that the user may miss.

**New**: `ctx.ui.confirm(title, message)` — interactive dialog with Yes/No. If confirmed, call the same `runDream()` function used by the `/dream` command.

Both the nudge path and the `/dream` command handler call a shared `runDream()` (from `src/dream.ts`), avoiding code duplication. The only difference: `/dream` asks its own confirm dialog before calling `runDream()`, while the nudge uses its confirm as the gate.

```typescript
const { nudge, message, sessions, newEntries } = await shouldNudge(memoryDir, config, ctx.cwd);
if (nudge) {
  const ok = await ctx.ui.confirm(
    "Memory Consolidation",
    `${message}\n\nConsolidate memory files now?`
  );
  if (ok) {
    const summary = await runDream({ model: config.dream.model, memoryDir, signal: ctx.signal });
    await writeDreamMeta(memoryDir, sessions);
    ctx.ui.notify(summary, "info");
  }
}
```

## 3. Files Changed

| File | Change |
|------|--------|
| `pi-memory/package.json` | Add `@yandy0725/pi-subagents` peerDependency |
| `pi-memory/src/dream.ts` | Rewrite `runDream()` to use `SubagentsService` + `WorkspaceProvider`; remove `resolveDreamModel()` and `extractSummary()`; merge `DREAM_SYSTEM_PROMPT` rules into `buildDreamTask()` (subagent uses prompt, not system prompt override); keep `buildDreamTask()` |
| `pi-memory/src/nudge.ts` | `shouldNudge()` returns additional `sessions` / `newEntries` counts for the confirm dialog |
| `pi-memory/index.ts` | Nudge: `notify` → `confirm`; Dream handler: use new `runDream()` signature |
| `pi-memory/tests/dream.test.ts` | Rewrite tests for new `SubagentsService`-based implementation |
| `pi-memory/tests/index-wiring.test.ts` | Update mocks for new flow |

## 4. API / Interface Changes

### `runDream()` signature change

**Old:**
```typescript
interface RunDreamOpts {
  model: any;                  // resolved model instance
  memoryDir: string;
  cwd: string;
  signal?: AbortSignal;
  createSession?: typeof createAgentSession;  // DI for tests
}
```

**New:**
```typescript
interface RunDreamOpts {
  model: string;               // dream.model config value ("auto" or "provider/id")
  memoryDir: string;
  signal?: AbortSignal;
  events?: { on(channel: string, handler: (data: any) => void): void };  // DI for tests
  service?: SubagentsService;   // DI for tests (production uses getSubagentsService())
}
```

**Note**: `cwd` is removed — the dream subagent's cwd is set via `WorkspaceProvider` to `memoryDir`.

### `shouldNudge()` return type change

**Old:**
```typescript
{ nudge: boolean; message: string }
```

**New:**
```typescript
{ nudge: boolean; message: string; sessions: number; newEntries: number }
```

## 5. Removed Code

- `resolveDreamModel()` — replaced by simple `dream.model === "auto" ? undefined : dream.model`
- `extractSummary(messages[])` — result is read from `getRecord(id).result`
- `buildDreamTask()` — still useful for constructing the prompt
- `DREAM_SYSTEM_PROMPT` — its rules (dedup, merge, index rebuild, title format) merged into `buildDreamTask()`; no systemPromptOverride needed
- Manual `DefaultResourceLoader` / `AuthStorage` / `ModelRegistry` setup in `runDream()`

## 6. Edge Cases & Error Handling

- **Service unavailable**: If `getSubagentsService()` returns `undefined` (pi-subagents not installed/loaded), show error notification
- **Dream agent error**: `subagents:failed` event → extract `record.error` → throw or return error string
- **Abort signal**: On signal fire, call `service.abort(agentId)`; subagent transitions to `"aborted"` status, triggering the completed/failed event handler
- **Workspace provider conflict**: `registerWorkspaceProvider()` throws if one is already registered. If this happens, dream fails gracefully with an error notification (no recovery possible — the other extension owns the provider).
- **Workspace provider leak**: Always call `unregister()` in finally block
- **Event listener leak**: Unsubscribe from both `subagents:completed` and `subagents:failed` in finally
- **Concurrent dreams**: The concurrency limiter may queue a dream spawn; the event listener still works since it filters by `agentId`
- **memoryDir doesn't exist**: `WorkspaceProvider.prepare()` should verify existence and throw a clear error if missing
