# Subagent Tool Set — Inheritance and Deltas — Design

- Date: 2026-11-23
- Package: pi-subagents
- Status: Approved 2026-11-23

## Intent

`tools` in an agent's frontmatter is the only thing that decides what a sub-agent can call. Its semantics misstate capability: omitted means "a fixed list of seven built-in tools" — a package-local snapshot of the host's tool set — and an empty list silently became that same snapshot. Consequences:

- A child never sees the tools other extensions provide, even though children load the parent's extensions: search, task boards, MCP servers, project-local tools are all registered and dead.
- The snapshot was wrong in both directions: it omitted the host's `powershell` built-in and switched on `grep`/`find`/`ls`, which the host leaves off by default.
- `tools: none` did not produce a tool-less agent at all (raised as bug #296).

The fix is not a patch to the snapshot but a contract: **the parent's tool set is the default, and a frontmatter list can narrow, replace, or extend it.**

## Goals

- Omitting `tools` gives the child **the parent session's current tool set**, minus this package's dispatch tools.
- `tools: none` (or an empty value) gives the child **zero tools**.
- A plain list gives the child exactly those tools and nothing else.
- A list of only `+name` / `-name` entries starts from the inherited set and adds or removes single tools.
- One definition of "dispatch tools" shared by resolution and the post-bind guard.

## Non-goals

- Sharing tool toggles with already-running children. The parent's set is snapshotted per spawn.
- MCP-specific policy in this package. Names are handed to the host unchanged and its `mcp__` rules apply as-is, including their side effects (see Consequences).
- Changing the `Explore` system prompt or its role.
- Showing the resolved tool set anywhere the user or the parent model could see it: not in the running-agents widget line, not in the `/subagents:sessions` transcript view, and not in the `subagent` tool's description of available types. Resolution is silent; the only places a child's tool set is visible are its frontmatter and the child's own rendered prompt. Observability of the resolved set is a separate change (it would touch the widget renderer, the tool description builder, and the record shape) and can be its own issue.

## Anti-goals

- **No "all built-in tools" fallback.** There is no constant listing host built-ins in this package, and none gets reintroduced.
- **No patterns.** `*` is rejected in every `tools` entry. The host allowlist matcher supports globs, which would reintroduce an "everything matching" mode and with it the all-tools door this contract closes.
- No per-call `tools` parameter on the `subagent` tool: the tool set is a property of the agent type.
- No re-derivation of the inherited set from `settings.defaultTools`: the parent's live active set is the source.

## Verified host mechanics (constraints)

Checked against `@earendil-works/pi-coding-agent` 1.5.0 (`createAgentSession`, `AgentSession`, `DefaultResourceLoader`) and by running real sessions:

1. **A `tools` list is a hard allowlist.** Only named tools activate; non-MCP tools registered by extensions stay registered but are never declared to the model, and `session.setActiveToolsByName()` cannot activate them. An empty list activates nothing and additionally filters MCP registrations out. Entries are matched by `createToolNameMatcher()`, so an entry containing `*` is a glob, not a name.
2. **A list of only `+name` / `-name` entries is not an allowlist.** The host applies them to `settings.defaultTools` (default `read`/`bash`/`edit`/`write`), leaves every extension tool free to activate, and *rejects the list outright* if plain names are mixed in. Modifier entries take exact names; a `*` is rejected.
3. **Host built-ins are eight:** `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`. Only the first four are active by default.
4. **`ctx.getActiveTools()` exists** on the extension context (`ExtensionContext`, also on the session-level context handed to `session_start`) and returns the names currently declared to the model. It is available on the tool-call path and on the path the cross-extension service uses (`runtime.currentCtx`).
5. **The recursion guard already runs post-bind**, filtering this package's dispatch tools out of the child's active set. With inheritance, those tools arrive active, so the guard becomes load-bearing rather than defensive.
6. **Children always load the parent's extensions** (existing behavior, unchanged), but bind without a UI context: `hasUI()` is false inside a child.
7. **No list of host built-in tool names is reachable from an extension.** The package root exports only `createCodingTools` (`read`/`bash`/`edit`/`write`), `createReadOnlyTools` (`read`/`grep`/`find`/`ls`), and the per-tool factories. `allToolNames`, `DEFAULT_TOOL_NAMES`, `createAllTools`, `createAllToolDefinitions`, `createTool`, and `createToolDefinition` are not in the root barrel, and extension code can only import the root. Any "all built-in tools" list would therefore be a hand-copied snapshot — exactly what #296 removed.
8. **`mcp__*` entries flip the host into MCP-allowlist mode.** When any entry starts with `mcp__`, MCP tools that do not match the list are filtered out of the child's registry, resource tools included, so they are unreachable even from codemode/tool_search. When no entry starts with `mcp__`, MCP tools stay registered but inactive.

Constraint 1 is the accepted cost of snapshotting: because the inherited set is passed as an allowlist, an extension that would activate a tool dynamically inside the child (tool_search/codemode loading) cannot do so. That is a deliberate trade for "the child matches the parent exactly".

## Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| Snapshot the parent's active tool names, apply `+`/`-` deltas in this package, pass the result as the allowlist | Child matches the parent exactly, including tools the user hid with `/tools` or `--tools`; deltas must be computed here; no dynamic activation inside the child | **Chosen** — the only reading of "the parent's tools" that holds when the parent has a non-default set |
| Pass `tools: undefined` and let the host resolve (default set + all extension tools); deltas handled by the host | Least code, deltas and dynamic activation free | Rejected — ignores parent runtime toggles, so a tool the user deliberately hid is handed to every child; the divergence lands exactly on the dangerous tools |
| Snapshot as the initial set, but leave the allowlist open so extensions can still activate | Closest to "match the parent, keep dynamic activation" | Rejected — the host has no "initial set without allowlist" option; it would need a host change |

## Design

### Config surface

`AgentConfig.toolNames?: string[]` (renamed from `builtinToolNames`; the frontmatter key stays `tools`).

| `tools` in frontmatter | Parsed as | Child gets |
|---|---|---|
| omitted | `undefined` | parent active set − dispatch tools |
| `none`, or empty | `[]` | nothing |
| `read, grep` | `["read", "grep"]` | exactly those |
| `-edit, -write, +powershell` | entries verbatim | parent active set, then deltas, then − dispatch tools |

Frontmatter parsing is unchanged in shape: entries are split on commas, trimmed, empty entries dropped, and otherwise passed through untouched — the resolver, not the parser, validates and interprets `+`/`-`.

### Resolution

New pure module `src/config/tool-names.ts`:

```ts
/** Tools registered by this package that a child must never be granted. */
export const DISPATCH_TOOL_NAMES = ["subagent", "get_subagent_result", "steer_subagent"] as const;

/** Throw when the list mixes plain names with modifiers, or a modifier contains a pattern. */
export function validateToolList(type: string, names: string[] | undefined): void;

/** Final allowlist for a child; `undefined` means "let the host resolve it". */
export function resolveToolNames(
	type: string,
	configured: string[] | undefined,
	parentActive: string[] | undefined,
): string[] | undefined;
```

`resolveToolNames` rules, in order:

1. `validateToolList(type, configured)` — throws `Agent "<type>" …` before any session is created when the list mixes plain names with `+`/`-` entries, or when any entry contains `*`.
2. `configured === undefined`: `parentActive === undefined` → `undefined` (the host resolves; see "Degraded path"); otherwise `dedupe(parentActive) − DISPATCH_TOOL_NAMES`.
3. `configured` empty → `[]`.
4. Modifier-only list: `parentActive === undefined` → return the entries unchanged (the host applies them to its own default set); otherwise `dedupe(applyModifiers(parentActive, configured)) − DISPATCH_TOOL_NAMES`.
5. Plain list: `dedupe(configured) − DISPATCH_TOOL_NAMES`.

Validation applies to inherited results too: the snapshot comes from the host's active set, which never contains `*`, so the only way a pattern reaches the allowlist is through frontmatter.

`applyModifiers` mirrors the host exactly: left to right, `-name` removes the name if present, `+name` adds it if absent. Dedupe preserves first occurrence. Dispatch tools are removed *after* deltas, so no configuration can grant them.

Two behaviors are worth stating because they are choices, not consequences:

- Dispatch names are stripped silently rather than rejected: a type that lists `subagent` gets a child without it, the same outcome the post-bind guard enforces anyway.
- `+name` may name a tool the parent does not have (for example `+powershell` while the parent runs the defaults). It is added to the allowlist and the host activates it if the child's registry has it, ignores it otherwise. This is the documented way to *widen* an inherited set.

### Threading the parent's active set

- `SessionContext` (this package's narrow type) gains `getActiveTools?(): string[]`.
- `ParentSnapshot` gains `activeToolNames?: string[]`, filled in `buildParentSnapshot()` from `ctx.getActiveTools?.()` — captured once at spawn, like every other snapshot field.
- `AssemblerContext` gains `activeToolNames?: string[]`; `assembleSessionConfig()` calls `resolveToolNames(type, registry.getToolNamesForType(type), ctx.activeToolNames)` and puts the result in `SessionConfig.toolNames?: string[]`.
- `createSubagentSession()` passes `snapshot.activeToolNames` into the assembler context and `cfg.toolNames` into `createSession({ tools })`.

### Registry

`AgentConfigLookup.getToolNamesForType(type)` returns `string[] | undefined` and passes the configured value through untouched (a copy), so the resolver owns interpretation. `BUILTIN_TOOL_NAMES` is deleted.

### Built-in agents

| Agent | `toolNames` | Why |
|---|---|---|
| `general-purpose` | omitted → inherit | Matches the caller; the role is "do what the caller could do, in a fresh context" |
| `Explore` | `["read", "bash", "grep", "find", "ls"]` | Read-only exploration. The host's `createReadOnlyTools` set is `read`/`grep`/`find`/`ls`; `bash` stays because exploration leans on read-only shell commands (`git log`, `rg`), and the `replace` prompt forbids every write. Named explicitly rather than derived, so the capability is a property of the agent, not of the host version. |

### Recursion guard

`create-subagent-session.ts` stops owning its private list and imports `DISPATCH_TOOL_NAMES`. The guard stays unconditional after `bindExtensions`: it is the second line of defense for the inherited case (resolution already stripped the names, but the child's own copy of this extension registers them at bind time).

### Breaking change

Two user-visible changes, both needing a major version bump and release notes:

1. Omitted `tools` previously produced a fixed seven-name list; it now inherits. Any user agent that relied on "no `tools` field" to get a narrow set must state the set or use deltas.
2. A `*` in `tools` is now rejected. Lists were previously forwarded to the host allowlist verbatim, so a pattern silently worked; a pattern is a fifth spelling of "matching tools" and inheritance already covers the case that motivated it, so the contract keeps exact names only.

## Degraded path

If `getActiveTools` is unavailable (a host without it), resolution returns `undefined` and the host's own defaults apply — the pre-#296 world minus the snapshot. The resource loader, the registry, and the docs never depend on the fallback; it exists so an older host degrades to "default set + extensions" instead of "zero tools".

## Consequences worth reviewing

- **Prompt size.** An inheriting child now carries the schemas and guidelines of every tool the parent had, including extension tools. `general-purpose` children get larger system prompts than before.
- **Hidden means hidden.** A parent running with `--tools read` or after `/tools` hides a tool, children lose it too. Users who relied on children having a fuller set must say so with `+name`.
- **No dynamic activation in children.** An extension that activates a tool mid-run (tool_search/codemode) cannot add it to a child. Documented, not worked around.
- **`Explore` remains the only child with a hard-coded list**, by design.
- **MCP reachability narrows when the parent had an active MCP tool.** Inheritance hands the host a list containing `mcp__…` names, which puts the child in MCP-allowlist mode: MCP tools the parent did not have active — resource tools included — are filtered out of the child's registry rather than merely left inactive. Passing the names verbatim is the exact-match promise; stripping them would be a package-level MCP policy, which is a non-goal.
- **UI-bound tools are inherited as-is.** A child has no UI, so a tool that needs a dialog (`ask_user`-style) is declared to the child and fails or returns its no-UI fallback if called. Tools are not classified by capability: the host exposes no "needs UI" flag, and any heuristic would silently change what a child can call.
- **A parent with no tools yields children with no tools.** `parentActive` being a known-empty array is different from being *unknown*: known-empty inherits faithfully as `[]`. Only the degraded path (host lacks `getActiveTools`) falls back to `undefined`.

## Testing strategy

- **Pure resolver** (`tests/config/tool-names.test.ts`): inherit with and without a parent set, empty list, plain list, delta order and idempotence, dedupe, dispatch stripping after deltas, `+name` for a tool the parent lacks, mixed list throws, `*` throws in both plain (`read*`, `*`) and modifier (`+web*`) form, message names the type.
- **Parser** (`tests/config/custom-agents.test.ts`): omitted → `undefined`, `none`/empty → `[]`, list → verbatim, `+`/`-` entries verbatim.
- **Registry** (`tests/config/agent-types.test.ts`): passthrough of `undefined`, `[]`, list; copies (no shared mutable arrays); unknown and disabled types inherit.
- **Assembler** (`tests/session/session-config.test.ts`): resolution wired through `ctx.activeToolNames`; validation errors surface from `assembleSessionConfig`.
- **Factory** (`tests/lifecycle/create-subagent-session.test.ts`): `createSession` receives the resolved list, `undefined` for an unknown parent set, and `[]` for `none`; the guard still strips dispatch tools.
- **Real host smoke check** (manual, recorded in the PR): `tools: []` → `[]`; inherit → parent set minus dispatch; `-edit,-write` → writers gone; `+powershell` → added; mixed list → host-independent error from our resolver.

## Docs

`README.md` and `README.zh.md`: the `tools` table gains the four spellings, the "no all-built-in fallback" line, and the two rejection rules (mixed lists, `*`); the frontmatter table's default becomes "inherit parent"; the default-agent table states `general-purpose` = inherit and `Explore` = its five names; the release notes mention both breaking changes (omitted `tools`, patterns).

## Left to the builder

Nothing semantic. Names may move between modules (`tool-names.ts` is a suggestion, not a requirement), and the resolver may be inlined into `session-config.ts` if that keeps the file readable — the rules above are what the tests pin.
