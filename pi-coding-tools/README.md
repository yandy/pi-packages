# pi-coding-tools

Pi package enabling `ls`/`find`/`grep` built-in tools.

## Features

- **ls/find/grep**: Enables these built-in tools that are off by default.

## AST/LSP 代码理解工具

新增 4 个 token-efficient 工具，让 LLM 用最少 token 理解代码库：

| Tool | 用途 | 机制 |
|------|------|------|
| `ast_grep_search` | 按 AST 结构搜索代码（比 grep 精准，不匹配注释/字符串） | ast-grep CLI |
| `lsp_symbols` | 文件骨架大纲（比 read 省 ~95% token） | LSP documentSymbol |
| `lsp_hover` | 查符号类型/文档（唯一能答"这表达式什么类型"） | LSP hover |
| `lsp_navigate` | 语义跳转：定义在哪 / 谁在用（operation: definition\|references） | LSP definition/references |

### 支持语言

| 语言 | LSP 服务器 | 安装 |
|------|-----------|------|
| TypeScript/JavaScript | typescript-language-server | `npm i -g typescript-language-server typescript` |
| Python | pyright | `npm i -g pyright` |
| Java | jdtls | Eclipse JDT LS（需 JDK 17+） |
| Kotlin | kotlin-language-server | [fwcd/kotlin-language-server](https://github.com/fwcd/kotlin-language-server) |
| C/C++ | clangd | `apt install clangd` / `brew install llvm`（需 compile_commands.json） |

`ast_grep_search` 支持 ts/tsx/js/python/java/kotlin/c/cpp，无需 LSP。

### ast-grep 二进制

`ast_grep_search` 需要 `ast-grep`（或 `sg`）二进制。安装：`npm i -g @ast-grep/cli` / `cargo install ast-grep` / `brew install ast-grep`。

### 配置

在 `coding-tools.json` 中可开关每个工具（默认全 true），并可整体关 LSP 或覆盖服务器：

```jsonc
{
  "ast_grep_search": true,
  "lsp_symbols": true,
  "lsp_hover": true,
  "lsp_navigate": true,
  "lsp": { "disabled": false, "servers": { "clangd": { "disabled": true } } }
}
```

## Installation

```bash
pi install npm:@yandy0725/pi-coding-tools
```

## Configuration

Configuration files control which tools are enabled. All default to `true`.

### Global config

`~/.pi/agent/coding-tools.json`:

```json
{
  "ls": true,
  "find": true,
  "grep": true
}
```

### Project config

`<project>/.pi/coding-tools.json` (overrides global):

```json
{
  "grep": false
}
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `ls` | `true` | Enable the `ls` built-in tool |
| `find` | `true` | Enable the `find` built-in tool |
| `grep` | `true` | Enable the `grep` built-in tool |
| `ast_grep_search` | `true` | Enable the AST-based code search tool |
| `lsp_symbols` | `true` | Enable the LSP document symbols tool |
| `lsp_hover` | `true` | Enable the LSP hover (type/docs) tool |
| `lsp_navigate` | `true` | Enable the LSP definition/references tool |
| `lsp` | — | LSP configuration block (`disabled`, `servers` overrides) |
