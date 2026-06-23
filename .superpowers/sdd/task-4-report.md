# Task 4 Report: Integration — index.ts + README + RELEASE + publish workflow

## What was implemented

1. **`pi-todo/index.ts`** — Default extension factory registering the `todo` tool:
   - Tool registration with `promptSnippet`, `promptGuidelines`, typebox parameters
   - `renderCall` / `renderResult` with full icon rendering (○/◉/✓/🔒) and expansion logic
   - `execute` handler dispatching `set`/`update`/`list` actions to `setTodos`/`updateTodo`/`listTodos`
   - Branch-safe reconstruction via `session_start` + `session_tree` events scanning `ctx.sessionManager.getBranch()`
   - Widget sync: `ctx.ui.setWidget("pi-todo", lines ?? undefined)` on every state change, guarded by `ctx.hasUI`

2. **`pi-todo/README.md`** — Package documentation (features, install, tool reference)

3. **`pi-todo/RELEASE.md`** — Release process (tag-based, GitHub Actions OIDC publish)

4. **`.github/workflows/publish.yml`** — Added `pi-todo-v*)` case branch to the tag-to-directory mapping

## Files changed

| File | Action |
|------|--------|
| `pi-todo/index.ts` | Created |
| `pi-todo/README.md` | Created |
| `pi-todo/RELEASE.md` | Created |
| `.github/workflows/publish.yml` | Edited (added `pi-todo-v*` case) |

## Results

### Typecheck
```
npm run typecheck -w pi-todo  → clean (no errors)
```

### Biome
```
npm run check -w pi-todo  → 1 warning (pre-existing: `as any` in tests/widget.test.ts:9)
```

### Tests
```
npm test -w pi-todo  → 2 files, 16 tests passed
```

## Deviations from brief

1. **Type cast for `params.status`**: Added `as TodoItem["status"] | undefined` on line 125 because typebox infers `string | undefined` from `Type.String({ enum: [...] })` but `updateTodo` expects the literal union `"pending" | "in_progress" | "done" | undefined`. This is a necessary TS strict-mode fix.

2. **Removed `case "list":` before `default:`**: Biome flagged `lint/complexity/noUselessSwitchCase` — the `case "list"` before `default` is redundant. Removed it; behavior is identical since both branches do the same thing.

3. **Biome formatting**: `npm run format` adjusted promptGuidelines string quoting (double → single where no interpolation) and ternary operator indentation. No semantic changes.

## Self-review

- **Completeness**: All spec items from the brief are covered: tool registration (promptSnippet/promptGuidelines), renderCall, renderResult, session_start + session_tree reconstruction, widget sync, README, RELEASE, publish workflow edit. ✓
- **Quality**: Clean wiring, correct event handlers, no dead code. Import paths match actual file structure. ✓
- **Discipline (YAGNI)**: No extra features beyond the brief. ✓
- **Testing**: All 16 existing tests pass. Typecheck clean. Biome clean (only pre-existing test warning). ✓

## Smoke test

**Skipped** — `pi` CLI (`pi -e ./pi-todo/index.ts`) is not available in this environment. The smoke test would require a running pi instance with the full TUI. Reliance on typecheck + existing tests is sufficient per the brief's guidance.

## Concerns

None.

## Final-Review Fixes

### What was changed

**Finding 1 — `list` omits item ids:**
- `pi-todo/src/todo-store.ts`: Changed `listTodos` output format from `${marker} ${t.title}` to `${marker} [${t.id}] ${t.title}` (e.g. `○ [a] Task A`).
- `pi-todo/tests/todo-store.test.ts`: Updated 4 assertions in the listTodos test to match the new id-including format.
- `pi-todo/index.ts`: Changed `execute` text computation so both `set` and `list` (success) return `listTodos(todos)`, while `update` remains `"OK"`. This ensures the LLM sees stored ids after `set`.

**Finding 2 — branch-safe reconstruction has no automated test:**
- `pi-todo/src/todo-store.ts`: Extracted `reconstructTodos` as an exported pure function over an entries array (last-write-wins).
- `pi-todo/index.ts`: Replaced the inline reconstruction loop with a call to `reconstructTodos(ctx.sessionManager.getBranch())`.
- `pi-todo/tests/todo-store.test.ts`: Added 5 tests covering empty entries, no-match, single match, last-write-wins, and missing `details.todos`.

### Test Results

```
$ npm test -w pi-todo
 ✓ tests/todo-store.test.ts (17 tests) 3ms
 ✓ tests/widget.test.ts (4 tests) 3ms
 Test Files  2 passed (2)
      Tests  21 passed (21)

$ npm run typecheck -w pi-todo
clean (no errors)

$ npm run check -w pi-todo
Checked 8 files. 1 warning (pre-existing: noExplicitAny in widget.test.ts:9)
``` The implementation matches the brief exactly modulo the minor type constraint fix and biome auto-formatting, both of which are necessary and correct.
