# pi-coding-tools

Pi package providing AST/LSP code-intelligence tools for pi.

> ## ⚠️ Breaking changes
>
> **In 0.6.0 (unreleased):**
>
> - **Built-in `ls`/`find`/`grep` are no longer activated.** This package now only provides the five AST/LSP tools below. pi's own default tool set is just `read`/`bash`/`edit`/`write`, so upgrading silently drops `ls`/`find`/`grep`.
> - **Re-enable them yourself** in user (`~/.pi/agent/settings.json`) or project (`.pi/settings.json`) settings: `{ "defaultTools": ["+ls", "+find", "+grep"] }`. The `+name` form adds to the inherited default set instead of replacing it.
> - **Legacy `ls`/`find`/`grep` keys in `coding-tools.json` are silently ignored** — no error, no effect.

## AST/LSP 代码理解工具

新增 5 个 token-efficient 工具，让 LLM 用最少 token 理解代码库：

| Tool | 用途 | 机制 |
|------|------|------|
| `ast_grep_search` | 按 AST 结构搜索代码（比 grep 精准，不匹配注释/字符串） | ast-grep CLI |
| `ast_grep_replace` | AST-aware 重写代码（dry-run 预览，apply=true 写盘） | ast-grep CLI `-r`/`-U` |
| `lsp_symbols` | 文件骨架大纲（比 read 省 ~95% token） | LSP documentSymbol |
| `lsp_hover` | 查符号类型/文档（唯一能答"这表达式什么类型"） | LSP hover |
| `lsp_navigate` | 语义跳转：定义在哪 / 谁在用（operation: definition\|references） | LSP definition/references |

### 支持语言

| 语言 | LSP 服务器 | 安装 |
|------|-----------|------|
| TypeScript/JavaScript | typescript-language-server | `npm i -g typescript-language-server` |
| Python | pyright | `npm i -g pyright` |
| Java | jdtls | Eclipse JDT LS（需 JDK 17+） |
| Kotlin | kotlin-language-server | [fwcd/kotlin-language-server](https://github.com/fwcd/kotlin-language-server) |
| C/C++ | clangd | `apt install clangd` / `brew install llvm`（需 compile_commands.json） |

`ast_grep_search` 支持 ts/tsx/js/python/java/kotlin/c/cpp，无需 LSP。

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

Per-server overrides also accept `command` (string array, e.g. `["clangd", "--background-index"]`) and `env` (string map).

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
