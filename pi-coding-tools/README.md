# pi-coding-tools

Pi package providing AST/LSP code-intelligence tools for pi.

## AST/LSP 代码理解工具

新增 5 个 token-efficient 工具，让 LLM 用最少 token 理解代码库：

| Tool | 用途 | 机制 |
|------|------|------|
| `ast_grep_search` | 按 AST 结构搜索代码（比 grep 精准，不匹配注释/字符串） | ast-grep CLI |
| `ast_grep_replace` | AST-aware 重写代码（dry-run 预览，apply=true 写盘） | ast-grep CLI `-r`/`-U` |
| `lsp_symbols` | 文件骨架大纲（比 read 省 ~95% token） | LSP documentSymbol |
| `lsp_hover` | 查符号类型/文档（唯一能答"这表达式什么类型"） | LSP hover |
| `lsp_navigate` | 语义跳转：定义在哪 / 谁在用（operation: definition\|references） | LSP definition/references |

### Supported languages

Servers are started with the pi session working directory as their root, so project-scoped files
(`node_modules`, `compile_commands.json`, Gradle/Maven metadata) are resolved relative to it.

| Language | LSP server | Install |
|------|-----------|------|
| TypeScript/JavaScript | tsc (native, TypeScript ≥ 7) → typescript-language-server | nothing for TypeScript ≥ 7; for ≤ 6: `npm i -g typescript-language-server typescript@6` |
| Python | pyright | `npm i -g pyright` |
| Java | jdtls | Eclipse JDT LS (needs Java 21+) |
| Kotlin | kotlin-language-server | [fwcd/kotlin-language-server](https://github.com/fwcd/kotlin-language-server) (needs JDK 11+) |
| C/C++ | clangd | `apt install clangd` / `brew install llvm` |

Prerequisites beyond the server binary itself:

- **TypeScript/JavaScript** — when the nearest `typescript` (walking up from the session working directory) is
  ≥ 7, the LSP built into it is used: `tsc --lsp --stdio` — no extra install, no `tsserver.js` involved.
  Force the fallback with `lsp.servers.tsc.disabled`. Older projects (TypeScript ≤ 6) fall back to
  typescript-language-server, which needs a TypeScript that ships `lib/tsserver.js`: install it globally
  (`npm i -g typescript-language-server typescript@6`), or in the project (`npm i -D typescript@6`) to pin it
  per repository. `typescript` 7.x is the native port and has no `tsserver.js`, so it cannot serve as that
  fallback; with no usable TypeScript the server fails with `Could not find a valid TypeScript installation`.
- **Python** — none: no interpreter or virtualenv is required to resolve standard-library symbols.
- **Java** — Java 21+ on `JAVA_HOME` or `PATH`. The `jdtls` wrapper picks its own `-data` directory.
- **Kotlin** — JDK 11+. The classpath is resolved with Gradle, Maven or a `kls-classpath` script, so a lone
  `.kt` file only gets partial results. fwcd's server is deprecated in favour of the official
  [kotlin-lsp](https://github.com/Kotlin/kotlin-lsp) (alpha); to use it, override the command:
  `"lsp": { "servers": { "kotlin-language-server": { "command": ["kotlin-lsp.sh", "--stdio"] } } }`.
- **C/C++** — `compile_commands.json` is only needed for project-specific include paths and defines;
  without it clangd falls back to a default compile command and basic hover/navigation still work.

`ast_grep_search` supports ts/tsx/js/python/java/kotlin/c/cpp and needs no LSP. Languages outside this
list (Rust, Go, Ruby, …) are not covered: `ast_grep_*` rejects unknown `lang` values, and `lsp_*` only knows
the languages above — for any other file it returns `No LSP server for <path>`. Configuration can override
the built-in servers but cannot register new ones.

### ast-grep 二进制

`ast_grep_search` 需要 `ast-grep`（或 `sg`）二进制。安装：`npm i -g @ast-grep/cli` / `cargo install ast-grep` / `brew install ast-grep`。

## Installation

```bash
pi install npm:@yandy0725/pi-coding-tools
```

## Configuration

Configuration files control which of the five tools are enabled. All default to `true`.

Full shape:

```jsonc
{
  "ast_grep_search": true,
  "ast_grep_replace": true,
  "lsp_symbols": true,
  "lsp_hover": true,
  "lsp_navigate": true,
  "lsp": { "disabled": false, "servers": { "clangd": { "disabled": true } } }
}
```

Per-server overrides also accept `command` (string array, e.g. `["clangd", "--background-index"]`).
Built-in server ids: `tsc` (native TypeScript ≥ 7), `typescript-language-server`, `pyright`, `jdtls`,
`kotlin-language-server`, `clangd`.

### Global config

`~/.pi/agent/coding-tools.json`:

```json
{
  "ast_grep_search": true,
  "lsp_hover": true
}
```

### Project config

`<project>/.pi/coding-tools.json` (overrides global):

```json
{
  "lsp_hover": false
}
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `ast_grep_search` | `true` | Enable the AST-based code search tool |
| `ast_grep_replace` | `true` | Enable the AST-based code rewrite tool (dry-run by default) |
| `lsp_symbols` | `true` | Enable the LSP document symbols tool |
| `lsp_hover` | `true` | Enable the LSP hover (type/docs) tool |
| `lsp_navigate` | `true` | Enable the LSP definition/references tool |
| `lsp` | — | LSP configuration block (`disabled`, `servers` overrides) |

## License

MIT
