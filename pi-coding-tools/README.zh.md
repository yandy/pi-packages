# pi-coding-tools

启用 `ls`/`find`/`grep` 内置工具的 Pi 扩展包。

## 功能

- **ls/find/grep**：启用这些默认关闭的内置工具。

## AST/LSP 代码理解工具

新增 5 个 token-efficient 工具，让 LLM 用最少 token 理解代码库：

| 工具 | 用途 | 机制 |
|------|------|------|
| `ast_grep_search` | 按 AST 结构搜索代码（比 grep 精准，不匹配注释/字符串） | ast-grep CLI |
| `ast_grep_replace` | AST-aware 重写代码（dry-run 预览，apply=true 写盘） | ast-grep CLI `-r`/`-U` |
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
  "ast_grep_replace": true,
  "lsp_symbols": true,
  "lsp_hover": true,
  "lsp_navigate": true,
  "lsp": { "disabled": false, "servers": { "clangd": { "disabled": true } } }
}
```

## 安装

```bash
pi install npm:@yandy0725/pi-coding-tools
```

## 配置

配置文件控制哪些工具处于启用状态。所有工具默认启用。

### 全局配置

`~/.pi/agent/coding-tools.json`：

```json
{
  "ls": true,
  "find": true,
  "grep": true
}
```

### 项目级配置

`<project>/.pi/coding-tools.json`（覆盖全局配置）：

```json
{
  "grep": false
}
```

### 字段说明

| 字段 | 默认值 | 说明 |
|-------|---------|------|
| `ls` | `true` | 启用 `ls` 内置工具 |
| `find` | `true` | 启用 `find` 内置工具 |
| `grep` | `true` | 启用 `grep` 内置工具 |
| `ast_grep_search` | `true` | 启用基于 AST 的代码搜索工具 |
| `ast_grep_replace` | `true` | 启用基于 AST 的代码重写工具（默认 dry-run） |
| `lsp_symbols` | `true` | 启用 LSP 文档符号工具 |
| `lsp_hover` | `true` | 启用 LSP 悬停（类型/文档）工具 |
| `lsp_navigate` | `true` | 启用 LSP 定义/引用工具 |
| `lsp` | — | LSP 配置块（`disabled`、`servers` 覆盖） |
