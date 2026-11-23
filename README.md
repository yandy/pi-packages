# pi-packages

A set of independent [pi](https://pi.dev) extension packages. Each one solves a single problem, none of them depend on each other, and `pi install` is all it takes — no patching of pi itself.

English | [中文](./README.zh.md)

## Install pi

```bash
npm install -g @earendil-works/pi-coding-agent
```

## Packages

| Package | The problem it solves | Extra requirements |
|---|---|---|
| [pi-sandbox](./pi-sandbox) | Let the agent's `bash` / `write` / `edit` touch only what they're allowed to touch | None (the landlock runner ships with the package) |
| [pi-subagents](./pi-subagents) | Hand work to sub-agents that run in parallel and pick a model per cost tier | None |
| [pi-coding-tools](./pi-coding-tools) | Read code by AST/LSP — fewer files, fewer tokens | `ast-grep` CLI, plus an LSP server per language |
| [pi-context-insight](./pi-context-insight) | One `/insight` and you know what the context is made of and where the money went | None |
| [pi-notify](./pi-notify) | With several pi instances open, know which one is waiting for you | `notify-send` on Linux; built-in PowerShell 5.1 on Windows |
| [pi-todo](./pi-todo) | The agent tracks work as it goes, with the board above the editor | None |
| [pi-ask-user](./pi-ask-user) | Stop and ask instead of guessing | None |
| [pi-vision-tools](./pi-vision-tools) | Non-multimodal models can see images too | Optional `sharp` (compression before sending) |
| [pi-web-tools](./pi-web-tools) | Web search and page fetching | Works with zero config; optional `DEEPSEEK_API_KEY` / `ALIYUN_API_KEY` |

## The ones worth a closer look

### pi-sandbox — a process-level sandbox

Model-issued `bash` / `write` / `edit` get process-level limits, with the runner chosen per platform: bwrap on Linux with a landlock fallback, the built-in seatbelt on macOS, a restricted token plus Low integrity label on Windows. The default mode, `workspace-write`, keeps the workspace, `/tmp` and any directories you explicitly grant writable and everything else on the host read-only; where no runner is available it **refuses to run** rather than silently falling back to an unrestricted shell.

Paths stay transparent — no change to your project or your toolchain commands, and none of the container overhead (path mapping, image maintenance, startup latency). Escalation is denial-first: the model cannot pre-emptively attach escalation fields, approval only pops after a real denial of the same kind in this session, and `Deny` accepts an optional reason that is passed back so the model learns why instead of rephrasing and retrying. `/permission` switches between three modes for the whole process, parent and every sub-agent together.

Two boundaries worth knowing: it only covers model-issued actions — `!command` you type yourself runs in your own shell; reads are never restricted (the sandboxed process can read everything you can), and the network is not isolated.

```bash
pi install npm:@yandy0725/pi-sandbox
```

### pi-subagents — sub-agents and model tiers

Sub-agents run inside the same pi runtime (not as child processes), so tool names, calling conventions and UI are identical. Background execution, automatic queueing past the concurrency limit, steering a running agent, resuming an interrupted one, and usage that rolls up into the parent session's cost.

What changes your day is **model tiers**: map `fast` / `standard` / `advanced` to real models in `subagents.json`, and the mapping is listed right in the `subagent` tool's `model` parameter description — the agent decides on its own that "find the files" is a `fast` job and "review this architecture" is an `advanced` one.

```json
{
  "modelTiers": {
    "fast": "deepseek-flash",
    "standard": "deepseek-flash",
    "advanced": "qwen3.8-max"
  }
}
```

There is no extra `model_tier` parameter; unconfigured tiers never appear in the parameter description or the prompt, nothing gets silently substituted, and a model pinned in an agent's frontmatter always wins. The global `~/.pi/agent/subagents.json` and the project `.pi/subagents.json` merge **per tier**, so a project can override one tier without restating the other two.

```bash
pi install npm:@yandy0725/pi-subagents
```

### pi-coding-tools — read code by structure

Five tools, all of them token-thrifty: `ast_grep_search` matches AST structure (no false hits in comments or strings), `ast_grep_replace` rewrites by structure (dry-run by default), `lsp_symbols` gives you the file outline for roughly 95% fewer tokens than a full `read`, `lsp_hover` is the only thing that answers "what type is this expression", and `lsp_navigate` jumps to definitions and finds references across files by semantic resolution rather than same-name text matching. Covers ts/tsx/js/python/java/kotlin/c/cpp; on projects with TypeScript ≥ 7 it uses the native LSP built into TypeScript, so there is no language server to install.

```bash
pi install npm:@yandy0725/pi-coding-tools
```

### pi-context-insight — the context ledger

`/insight` writes a single self-contained HTML file, fully offline (strict CSP, no external requests, no `eval`). It reconstructs, request by request, the prompt the model actually received — each system-prompt segment, tool schemas, messages, tool results — and diffs it against the previous request, so "why is the context growing this fast" becomes answerable: a 16-way token breakdown, cache hit rate, cost, time split across model / tools / other with idle removed, window occupancy and compaction reserve, and a separate section for every sub-agent. The default report contains raw text; `--short` keeps an identical structure with none of it, so you can send it to someone else.

```bash
pi install npm:@yandy0725/pi-context-insight
```

### pi-notify — so you don't babysit terminals

With several pi instances open, notifications only arrive at two moments: a dialog is waiting for you (including ones raised by other extensions), or a turn actually finished (with duration and a summary of the last reply). Every notification names the session and pid. Turns under 10 seconds, interrupted turns, `custom` turns and sub-agents stay silent; `/notify` toggles it at runtime. Delivery is fire-and-forget, so a failing notifier never blocks the agent loop.

```bash
pi install npm:@yandy0725/pi-notify
```

### pi-todo — one tool, one board

The `todo` tool has three actions (plan, change one, check progress) and comes with a board above the editor. Tasks can declare `blockedBy` dependencies, and state is rebuilt from the session branch, so `/fork` and `/resume` leave a correct list behind.

It also fixes the "batch the bookkeeping at the end" failure mode: while the board still has unfinished tasks and hasn't been updated for a while, a short reminder is appended to the next request (first after 5 turns, then 10 / 20 / 40). The reminder exists only in that one request and is never persisted, so a long run never accumulates contradictory snapshots of "the current state".

```bash
pi install npm:@yandy0725/pi-todo
```

### pi-ask-user — ask instead of guessing

Searchable split-pane options, multi-select, freeform text, and an optional note after choosing. Local timeout and interruption always win: a non-interactive host that never answers cannot hang the turn, and a timeout settles as cancelled — **not** as approval, so no command runs and no file is written. Ships a built-in skill that turns "ask before guessing on a high-stakes or ambiguous task" into a fixed decision handshake.

```bash
pi install npm:@yandy0725/pi-ask-user
```

### pi-vision-tools — eyes for models without them

The calling model hands an image and a prompt to `describe_image`; a configured vision model looks at it and returns text. The tool turns itself on and off based on whether the calling model accepts image input — it simply doesn't exist while you're on a multimodal model, and switching models switches the behaviour with no manual toggle. The vision model takes an exact `provider/id` or a fuzzy name like `haiku` or `qwen vl`, and `compress` / `thinkLevel` are chosen per call — turn compression off when you need pixel coordinates.

```bash
pi install npm:@yandy0725/pi-vision-tools
```

### pi-web-tools — search and fetch

`websearch` works with zero config, defaulting to Exa's free tier (150 requests/day); Chinese queries can fall back to DeepSeek or Aliyun, and a failing provider falls through to the next one automatically. `webfetch` turns a URL into readable Markdown, and falls back to server-side rendering when a local fetch comes back thin or the page needs JavaScript.

```bash
pi install npm:@yandy0725/pi-web-tools
```

## Requirements

All of them require **pi >= 1.5.0**. pi does not validate that peer floor when installing an extension, so on an older host an extension can fail during load — that matters most for pi-sandbox, where `bash` / `write` / `edit` then silently fall back to the built-in unrestricted implementations. Run `/permission` after installing to confirm it is actually in effect.

## Development

This repository is an npm workspaces monorepo.

```bash
npm ci                    # Install all dependencies (root + all workspaces)
npm run typecheck         # Type-check all packages
npm run lint              # Biome lint
npm run format            # Format all packages
npm test                  # Run all tests
```

## License

MIT — the single [LICENSE](./LICENSE) at the repository root covers every package in this monorepo.
Packages do not keep their own copy: `prepack` injects the root license into each published tarball.
