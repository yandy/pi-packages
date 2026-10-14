# pi-coding-tools

提供 AST/LSP 代码智能工具的 Pi 扩展包。

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

服务器以 pi 会话的工作目录为根启动，所以项目内的文件（`node_modules`、`compile_commands.json`、
Gradle/Maven 元数据）都相对它解析。

| 语言 | LSP 服务器 | 安装 |
|------|-----------|------|
| TypeScript/JavaScript | typescript-language-server | `npm i -g typescript-language-server typescript@6` |
| Python | pyright | `npm i -g pyright` |
| Java | jdtls | Eclipse JDT LS（需 Java 21+） |
| Kotlin | kotlin-language-server | [fwcd/kotlin-language-server](https://github.com/fwcd/kotlin-language-server)（需 JDK 11+） |
| C/C++ | clangd | `apt install clangd` / `brew install llvm` |

除服务器二进制本身外的前置依赖：

- **TypeScript/JavaScript** —— 服务器还需要一个带 `lib/tsserver.js` 的 TypeScript：先按会话工作目录逐级向上找
  `<项目>/node_modules/typescript/lib`，找不到就退回装在服务器自己旁边的（即全局）`typescript`。`typescript`
  7.x 是 native 移植版、没有 `tsserver.js`，不能用；请装 `typescript@6`——全局装，或装进项目
  （`npm i -D typescript@6`）按仓库固定版本。没有任何可用的 TypeScript 时，对 js/ts 文件的每次 `lsp_*`
  调用都会报 `Could not find a valid TypeScript installation`。
- **Python** —— 无额外依赖：解析标准库符号不需要解释器或 virtualenv。
- **Java** —— 需要 Java 21+（`JAVA_HOME` 或 `PATH`）；`jdtls` 包装脚本会自己挑 `-data` 目录。
- **Kotlin** —— 需 JDK 11+；classpath 由 Gradle、Maven 或 `kls-classpath` 脚本解析，所以单独的 `.kt`
  文件只有有限结果。fwcd 版已废弃，官方 [kotlin-lsp](https://github.com/Kotlin/kotlin-lsp)（alpha）可用：
  把命令覆盖为 `"lsp": { "servers": { "kotlin-language-server": { "command": ["kotlin-lsp.sh", "--stdio"] } } }`。
- **C/C++** —— `compile_commands.json` 只在需要项目专属 include 路径与宏时才必需；没有它 clangd 会退回
  默认编译命令，基本 hover/跳转仍可用。

`ast_grep_search` 支持 ts/tsx/js/python/java/kotlin/c/cpp，无需 LSP。上表之外的语言（Rust、Go、Ruby……）不在
覆盖范围内：`ast_grep_*` 会拒绝未知的 `lang`，`lsp_*` 也只认上面这 5 个服务器——其它文件返回
`No LSP server for <path>`。配置只能覆盖这 5 个服务器，不能新注册。

### ast-grep 二进制

`ast_grep_search` 需要 `ast-grep`（或 `sg`）二进制。安装：`npm i -g @ast-grep/cli` / `cargo install ast-grep` / `brew install ast-grep`。

## 安装

```bash
pi install npm:@yandy0725/pi-coding-tools
```

## 配置

配置文件控制这 5 个自定义工具的启用状态。所有工具默认启用。

完整结构：

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

per-server 覆盖项还支持 `command`（字符串数组，如 `["clangd", "--background-index"]`）。

### 全局配置

`~/.pi/agent/coding-tools.json`：

```json
{
  "ast_grep_search": true,
  "lsp_hover": true
}
```

### 项目级配置

`<project>/.pi/coding-tools.json`（覆盖全局配置）：

```json
{
  "lsp_hover": false
}
```

### 字段说明

| 字段 | 默认值 | 说明 |
|-------|---------|------|
| `ast_grep_search` | `true` | 启用基于 AST 的代码搜索工具 |
| `ast_grep_replace` | `true` | 启用基于 AST 的代码重写工具（默认 dry-run） |
| `lsp_symbols` | `true` | 启用 LSP 文档符号工具 |
| `lsp_hover` | `true` | 启用 LSP 悬停（类型/文档）工具 |
| `lsp_navigate` | `true` | 启用 LSP 定义/引用工具 |
| `lsp` | — | LSP 配置块（`disabled`、`servers` 覆盖） |

## License

MIT
