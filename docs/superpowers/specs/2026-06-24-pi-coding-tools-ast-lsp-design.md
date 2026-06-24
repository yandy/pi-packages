# Design: pi-coding-tools — AST/LSP 代码理解工具

**Date:** 2026-06-24
**Status:** draft

## Summary

扩展现有 `@yandy0725/pi-coding-tools` 包，从"启用文件级内置工具（ls/find/grep）"升级为**三层代码理解工具集**，让 LLM 用最少的 token 理解代码库——把 token 消耗从"逐文件读全文"降到"按需获取结构摘要 + 精准搜索 + 类型查询 + 语义导航"。

| 层 | 工具 | 机制 | 状态 |
|----|------|------|------|
| 文件级 | `ls` / `find` / `grep` | pi 内置 | 现有 |
| AST 级 | `ast_grep_search` | ast-grep CLI | 新增 |
| 语义级 | `lsp_symbols` / `lsp_hover` / `lsp_navigate` | LSP | 新增 |

新增 4 个自定义工具，全部通过现有 `coding-tools.json` 配置可开关（全局 + 项目覆盖，默认启用），向后兼容。版本 `0.2.0 → 0.3.0`（minor，增量）。

**设计依据**：`.superpowers/refs/pi-extension.md`（草案设计）、`.superpowers/refs/pi-ast-grep`（ast-grep 二进制管理，MIT）、`.superpowers/refs/pi-lsp-client`（LSP 生命周期，MIT）、`.superpowers/refs/pi-lens`（综合参考）。

### 关键决策摘要

| 决策 | 结论 | 理由 |
|------|------|------|
| 新建包 vs 扩展现有 | **扩展现有 pi-coding-tools** | 主题一致（coding tools），控制包数；现有 config 模式天然延伸 |
| 工具数 | **4**（ast_grep_search / lsp_symbols / lsp_hover / lsp_navigate） | goto_def+find_references 合并进 `lsp_navigate(operation)` 压到 4 |
| 工具命名 | **机制前缀**（`ast_grep_*` / `lsp_*`），非 `code_*` | 机制名编码行为契约（ast-grep≠正则、LSP 需服务器）、与内置 `grep` 区分、匹配生态约定、prime ast-grep 模式语法 |
| AST 后端 | **ast-grep CLI**（二进制 `ast-grep`/`sg`） | 简单、二进制管理成熟；napi 仅内置 ts/js 不覆盖 py/java/kotlin/c-c++，放弃 |
| LSP 管理 | **最小自写**（懒加载+进程缓存+空闲超时+崩溃重启一次） | v1 精简；refcount/init-reaping 留 P1 |
| `lsp_symbols` fallback | **不做** ast-grep fallback，纯 LSP | hover/navigate 必须有 LSP，没装 LSP 是半残；fallback 只救孤立 symbols 价值低，且省 5 套语言模式工作量；质量不如 LSP |
| P0 语言 | ts/js、python、java/kotlin、c/c++ | 用户选择 |
| 方案档位 | **方案 A（精简）** | 精简优先，健壮性增量留 P1 |
| 开发方式 | **git worktree 隔离开发** | 实施阶段用 using-git-worktrees skill 建隔离工作区，避免干扰主分支 |

## 开发方法

实施阶段使用 **git worktree** 建立隔离工作区（`using-git-worktrees` skill），避免在主工作区直接改动。所有代码变更、测试、验证均在 worktree 内进行，完成后再合并回主分支。这与本 monorepo 既有 `.worktrees/` 目录约定一致。

## Scope

### 新建文件

| File | Purpose |
|------|---------|
| `pi-coding-tools/src/ast-grep/binary.ts` | `ast-grep`/`sg` 二进制解析：PATH(优先 ast-grep) → `@ast-grep/cli` → 平台包 → 可选 GitHub 下载（`PI_OFFLINE` 可关） |
| `pi-coding-tools/src/ast-grep/search.ts` | 执行 `ast-grep run --json=compact`，解析+格式化；正则式 pattern 检测与提示 |
| `pi-coding-tools/src/lsp/manager.ts` | `LspManager`：懒加载 + `Map<lang,server>` 缓存 + 空闲超时(5min) + 崩溃驱逐重启一次 + dispose |
| `pi-coding-tools/src/lsp/client.ts` | JSON-RPC over stdio（`vscode-jsonrpc`）：initialize/didOpen/hover/documentSymbol/definition/references；位置换算；mtime 重开刷新 |
| `pi-coding-tools/src/lsp/servers.ts` | 每语言服务器定义（command/args/extensions/initOptions/installHint/installed 探测） |
| `pi-coding-tools/src/tools/ast-grep-search.ts` | `ast_grep_search` 工具定义（params/promptSnippet/promptGuidelines/execute） |
| `pi-coding-tools/src/tools/lsp-symbols.ts` | `lsp_symbols` 工具定义 |
| `pi-coding-tools/src/tools/lsp-hover.ts` | `lsp_hover` 工具定义 |
| `pi-coding-tools/src/tools/lsp-navigate.ts` | `lsp_navigate` 工具定义（operation: definition\|references） |
| `pi-coding-tools/src/formatters.ts` | 紧凑 LLM 友好输出格式化（纯函数） |
| `pi-coding-tools/tests/ast-grep-search.test.ts` | search 格式化、JSON 解析、pattern-hint 检测单测 |
| `pi-coding-tools/tests/formatters.test.ts` | 各工具输出格式单测 |
| `pi-coding-tools/tests/lsp-manager.test.ts` | manager 生命周期逻辑（mock client）：空闲驱逐/崩溃重启/dispose |
| `pi-coding-tools/tests/lsp-client.test.ts` | JSON-RPC 协议（fake LSP server 夹具）：didOpen/hover/docSymbol/def/refs |
| `pi-coding-tools/tests/fixtures/fake-lsp-server.mjs` | 讲 JSON-RPC 的假服务器，供协议测试 |
| `pi-coding-tools/tests/tools-registration.test.ts` | 工具注册 + execute（mock 后端）断言 |
| `pi-coding-tools/tests/sg-binary.integration.test.ts` | `sg` 可用时对夹具跑真实搜索，离线跳过 |

### 修改文件

| File | Change |
|------|--------|
| `pi-coding-tools/index.ts` | factory 注册 4 工具；`session_start` 按 config 把启用工具加入活动集；`session_shutdown` 调 `LspManager.dispose()` |
| `pi-coding-tools/src/config.ts` | 配置 schema 扩展 4 个工具布尔（`ast_grep_search`/`lsp_symbols`/`lsp_hover`/`lsp_navigate`）+ 可选 `lsp` 配置块；`CodingToolsConfig` 类型扩展 |
| `pi-coding-tools/src/search-tools.ts` | `enableSearchTools` 重命名为 `enableTools`，按 config 同时管理 7 个工具（ls/find/grep + 4 新工具）的活动集 |
| `pi-coding-tools/tests/search-tools.test.ts` | 更新为 `enableTools`，增加 4 新工具的活动集断言 |
| `pi-coding-tools/package.json` | version → 0.3.0；`dependencies` 加 `@ast-grep/cli`、`vscode-jsonrpc`、`extract-zip`；`files` 含新增 src 子目录 |
| `pi-coding-tools/README.md` | 增 4 工具说明、语言支持、LSP 安装、配置、ast-grep 二进制说明 |
| `pi-coding-tools/NOTICE` | 注明 ast-grep 二进制解析逻辑源自 pi-ast-grep（MIT） |
| `README.md`（根） | pi-coding-tools 描述行更新（apply_patch 描述与现状不符，一并修正为"ls/find/grep + AST/LSP 代码理解工具"） |

### 不涉及变更

- 不修改 pi-coding-agent 源码
- 不修改 pi-web-tools / pi-todo / pi-container-sandbox
- 不实现 `apply_patch`（旧设计文档提及但现状未实现，本次不引入）
- 不引入 formatters/linters/diagnostics（pi-lens 领域）
- 不做 ast-grep replace / lsp rename（写操作，风险高，留 P1）

## Architecture

### 三层工具集

```
pi session
│
├── ls / find / grep        ─── pi 内置（enableSearchTools 激活）
│
├── ast_grep_search         ─── exec ast-grep run --pattern ... --json
│                                 │
│                            ast-grep/binary.ts（ast-grep/sg 解析）
│                            ast-grep/search.ts（执行+格式化+pattern-hint）
│
└── lsp_symbols / lsp_hover / lsp_navigate
                              │
                         LspManager（懒加载 + 进程缓存 + 空闲超时 + 崩溃重启）
                              │
                         lsp/client.ts（JSON-RPC over stdio）
                              │
                    ┌─────────┼─────────┐
                    │         │         │
              tsserver    pyright    jdtls / clangd / ...
                    │         │         │
              (hover / documentSymbol / definition / references 共用同一连接)
```

`lsp_symbols`、`lsp_hover`、`lsp_navigate` 共用同一个 `LspManager`，同一语言复用同一进程连接，无额外开销（呼应草案"共用同一个 LSP 连接"）。

### 模块结构

```
pi-coding-tools/
├── index.ts                      # 入口：注册工具 + session_start 激活 + session_shutdown 清理
├── src/
│   ├── config.ts                 # 扩展：+ 4 工具布尔 + lsp 配置块
│   ├── search-tools.ts           # 扩展：管理 7 个工具的活动集
│   ├── ast-grep/
│   │   ├── binary.ts             # sg 解析
│   │   └── search.ts             # 搜索执行+格式化+pattern-hint
│   ├── lsp/
│   │   ├── manager.ts            # 生命周期管理
│   │   ├── client.ts             # JSON-RPC + 位置换算 + mtime 刷新
│   │   └── servers.ts            # 每语言服务器定义
│   ├── tools/
│   │   ├── ast-grep-search.ts
│   │   ├── lsp-symbols.ts
│   │   ├── lsp-hover.ts
│   │   └── lsp-navigate.ts
│   └── formatters.ts             # 纯函数输出格式化
└── tests/
    ├── fixtures/fake-lsp-server.mjs
    └── ...（见 Scope）
```

## Tool 详细设计

### `ast_grep_search` — AST 结构搜索

**后端**：ast-grep CLI（二进制名 `ast-grep`/`sg`，见下）

| 参数 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `pattern` | string | ✅ | ast-grep 模式。`$VAR` 匹配单节点，`$$$` 匹配零或多个节点。非正则 |
| `lang` | string | ❌ | 语言（ts/js/py/java/kotlin/cpp 等），不传按扩展名推断 |
| `path` | string | ❌ | 搜索路径，默认 `ctx.cwd` |

**Prompt 设计**：
```
promptSnippet: "Search code by AST structure (more precise than grep; ignores comments/strings)"
promptGuidelines: [
  "Use ast_grep_search to find code by syntax structure. It ignores comments and string literals and handles cross-line patterns — use built-in grep only for plain text or comments.",
  "Patterns are AST nodes, not regex. Use $VAR (e.g. $X, $NAME) for a single node wildcard, $$$ for zero-or-more nodes. Example: 'console.log($MSG)' matches any console.log call.",
  "Do NOT use regex constructs (\\w, .*, |, [a-z], trailing ':') — they will not match. The tool returns a hint if it detects regex-style patterns.",
  "To find definitions: 'function $NAME($$$) { $$$ }' (ts/js), 'def $NAME($$$)' (py). Always pass --lang when the project mixes languages.",
]
```

**输出**：
```
4 matches • 3 files
src/index.ts (1 match)
  11:3  console.log("greeting");
src/foo.ts (2 matches)
  18:5  console.log(error);
  27:3  console.log("ready");
```

### `lsp_symbols` — 文件骨架大纲

**后端**：LSP `textDocument/documentSymbol`（纯 LSP，无 fallback）

| 参数 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `path` | string | ✅ | 目标文件 |

无 LSP 服务器时返回友好"请安装 <server>"提示。

**输出**：
```
src/services/user_service.ts
├── export interface UserDTO
├── export class UserService
│   ├── constructor(db: Database)
│   ├── async findById(id: string): Promise<UserDTO>
│   └── async delete(id: string): Promise<void>
└── function validateEmail(email: string): boolean
```

Token 对比：全文 read ≈ 1200 tokens vs 骨架 ≈ 60 tokens（省 ~95%）。

### `lsp_hover` — 类型/文档查询

**后端**：LSP `textDocument/hover`

| 参数 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `path` | string | ✅ | 文件 |
| `line` | number | ✅ | 行号（1-based） |
| `character` | number | ✅ | 列（0-based） |

**输出**：
```
(method) UserService.validateToken(token: string, secret: string): boolean
Validate a JWT token against the secret.
```

### `lsp_navigate` — 语义导航

**后端**：LSP `textDocument/definition` / `textDocument/references`

| 参数 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `path` | string | ✅ | 文件 |
| `line` | number | ✅ | 行号（1-based） |
| `character` | number | ✅ | 列（0-based） |
| `operation` | `"definition" \| "references"` | ✅ | 跳定义 / 查引用 |

**输出**：
```
# definition
→ src/auth.ts:42:1  function validateToken(token: string, secret: string): boolean

# references (7)
src/auth.ts:89:5   validateToken(req.headers.authorization, config.secret)
src/user.ts:15:3   validateToken(input.token, env.JWT_SECRET)
```

**为什么 `lsp_navigate` 必要**：`ast_grep_search` 是文本/结构近似，搜 `findById($$$)` 会把定义与所有调用混在一起、无法穿透继承/接口/重载、看不见 `node_modules` 类型定义、有同名符号假阳性。`lsp_navigate` 是语义级精准：definition 返回 1 条真实定义，references 只返回对**该**符号的真实引用。比 ast-grep 更准且更省 token。

## AST 后端

### 二进制解析（`ast-grep/binary.ts`）

> **二进制名修正**：ast-grep 的 CLI 二进制在不同安装方式下名字不同——`cargo install ast-grep` / `brew install ast-grep`（Linux/macOS）装的是 **`ast-grep`**；而 `@ast-grep/cli` npm 包内部的 shim 叫 **`sg`**。pi-ast-grep 只找 `sg`，会漏掉只有 `ast-grep` 的系统。**本包同时找两者，优先 `ast-grep`**（Linux 标准名），`sg` 作为 npm shim fallback。

解析顺序（借鉴 pi-ast-grep MIT 逻辑，NOTICE 注明）：

1. **PATH** — 优先找 `ast-grep`（`ast-grep.exe` on Windows），再找 `sg`（`sg.exe`）。`ast-grep` 优先因为它是 cargo/brew/Linux 的标准二进制名
2. **`@ast-grep/cli` npm 包** — createRequire 相对本包解析包内 `sg` shim
3. **平台 npm 包** — `@ast-grep/cli-{platform}-{arch}-{libc}`（darwin/linux/win × arm64/x64），其内二进制名为 `ast-grep`
4. **GitHub release 自动下载**（最后手段，`PI_OFFLINE=1` 关闭）— 拉 `app-{arch}-{os}.zip` 解压到 `$XDG_CACHE_HOME/pi-coding-tools/bin/ast-grep`，按存在+>10KB 校验

**Trust model**：自动下载仅 HTTPS，无校验和（同 pi-ast-grep）。需可复现性则手动装 `ast-grep` + `PI_OFFLINE=1`。

### 搜索执行（`ast-grep/search.ts`）

```
ast-grep run --pattern <p> --lang <l> --json=compact <path>
```

（`--json=compact` 同 pi-ast-grep，输出更紧凑的 JSON）

- 解析 JSON 输出，归一化为 `{file, line, column, text}` 列表
- lang 未传时按 `path` 扩展名/目录文件推断
- **pattern-hint**：检测 `\w`/`\d`/`\s`/`\b`/`.*`/`.+`/`|`/`[a-z]`/尾冒号等正则特征 → 返回提示"this looks like regex; ast-grep uses AST patterns ($VAR/$$$), use built-in grep for text search"

## LSP Manager

### `LspManager`（`lsp/manager.ts`）

```typescript
class LspManager {
  private servers = new Map<string, LspServer>();   // lang → server
  async getServerForFile(path: string): Promise<LspServer> {
    const lang = detectLanguage(path);
    let server = this.servers.get(lang);
    if (!server || server.dead) {
      server = await this.startServer(lang);        // spawn + initialize + initialized
      this.servers.set(lang, server);
    }
    await server.ensureOpen(path);                   // didOpen，mtime 变则重开
    this.resetIdleTimer(lang);                       // 5min 无活动 → stop+remove
    return server;
  }
}
```

- **懒加载**：首次 `lsp_*` 调用才 spawn 对应语言服务器
- **进程缓存**：同语言复用进程
- **空闲超时**：5min 无活动 → stop + 移除；每次请求重置
- **崩溃处理**：JSON-RPC 抛连接关闭/进程退出 → 驱逐死服务；读操作（hover/symbols/def/refs 幂等）**重启一次**重试；持续失败 → 明确报错
- **session_shutdown**：`dispose()` 停所有服务、清所有计时器
- **不做**：refcount、init-reaping(60s)、capabilities 缓存（P1）

### `lsp/client.ts` — JSON-RPC over stdio

用 `vscode-jsonrpc` 直接连 spawn 进程的 stdin/stdout。方法：

- `initialize` / `initialized`
- `textDocument/didOpen`（首次）+ mtime 变化时 `didClose`+`didOpen` 重开刷新
- `textDocument/hover` / `documentSymbol` / `definition` / `references`

**位置换算**：对外 `line` 1-based、`character` 0-based（与 pi-lsp-client 一致，与 pi `read` 显示的行号一致）；内部转 LSP 0-based。

**新鲜度策略**：`ensureOpen` 时若文件已开且 mtime 自上次 open 变了 → 重开。简单可靠，捕获 agent 通过 pi edit/write 的外部编辑，无需订阅 pi 事件。（post-edit `didChange` via `tool_result` hook = P1。）

### `lsp/servers.ts` — 服务器定义

| 语言 | server id | command | 备注 |
|------|-----------|---------|------|
| TS/JS | typescript-language-server | `typescript-language-server --stdio` | 需项目或全局 typescript |
| Python | pyright | `pyright-langserver --stdio` | basedpyright 备选 |
| Java | jdtls | `jdtls` | 需 JDK；启动慢 |
| Kotlin | kotlin-language-server | `kotlin-language-server` | |
| C/C++ | clangd | `clangd` | 依赖 `compile_commands.json`，无它则 hover/goto 受限（documentSymbol 仍可用） |

每定义含：`id`、`command`+`args`、`extensions`、`initOptions`、`installHint`、`installed`（PATH 探测）。无探测到时返回 installHint。

## 配置 schema

扩展现有 `coding-tools.json`（全局 `~/.pi/agent/coding-tools.json` + 项目 `.pi/coding-tools.json`，项目覆盖全局，默认全 true）：

```jsonc
{
  "ls": true, "find": true, "grep": true,
  "ast_grep_search": true,
  "lsp_symbols": true,
  "lsp_hover": true,
  "lsp_navigate": true,
  "lsp": {
    "disabled": false,            // 整体关 LSP（lsp_hover/lsp_navigate 失效，lsp_symbols 返回提示）
    "servers": {
      // 可选：覆盖/禁用某语言服务器，类 pi-lsp-client 的 lsp-client.json
      "pyright": { "command": ["basedpyright-langserver", "--stdio"] },
      "clangd": { "disabled": true }
    }
  }
}
```

未配置项默认 `true`，向后兼容。用户可只开 `ast_grep_search`（无需 LSP）或关掉任一工具。

## 输出格式原则

`formatters.ts` 纯函数，全部遵循"LLM 优先"紧凑格式：

- ❌ 不用表格（`┌──┬──┐` 浪费 token）
- ✅ `path:line  → text` 紧凑行
- ✅ 树形大纲用 `├──` / `│` 缩进
- ✅ 计数摘要前置（`4 matches • 3 files` / `references (7)`）

## 错误处理

| 场景 | 行为 |
|------|------|
| `sg` 二进制缺失 | 安装提示（npm/cargo/brew）+ `PI_OFFLINE` 说明 |
| 正则式 pattern | pattern-hint 引导改用内置 grep |
| LSP 服务器未装 | `lsp_symbols`/`lsp_hover`/`lsp_navigate` 返回"请装 <server>"installHint |
| LSP 崩溃 | 驱逐 + 重启一次（读操作）；持续失败 → 明确报错 |
| 文件不存在 / 不支持语言 | 明确报错 |
| 全部场景 | 永不阻塞其他工具，优雅降级 |

## 测试策略

| 层 | 内容 | 方式 |
|----|------|------|
| 纯单元 | formatters 全部输出格式 | 喂结构化输入断言文本 |
| 纯单元 | config 合并/默认/覆盖 | 扩展现有 config.test.ts |
| 纯单元 | ast-grep JSON 解析、pattern-hint 检测 | 喂假 stdout |
| 纯单元 | 位置换算 | 1-based/0-based 互转 |
| LSP manager | 空闲驱逐、崩溃重启一次、dispose | mock client（无真实服务器） |
| LSP 协议 | didOpen/hover/docSymbol/def/refs | `fixtures/fake-lsp-server.mjs` 假服务器端到端 |
| ast-grep 集成 | 真实 `ast-grep` 搜索夹具 | `ast-grep` 可用才跑，离线跳过 |
| 工具注册 | 工具注册 + execute 返回 | mock 后端 |

## 入口接线（`index.ts`）

```typescript
export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const lsp = new LspManager();              // 懒创建，首次用才 spawn

  // factory 注册 4 工具
  pi.registerTool(ast_grep_search);
  pi.registerTool(lsp_symbols);
  pi.registerTool(lsp_hover);
  pi.registerTool(lsp_navigate);

  pi.on("session_start", async (_e, _ctx) => {
    enableTools(pi, config);                 // 扩展：7 个工具按 config 加入活动集
  });

  pi.on("session_shutdown", async (_e, _ctx) => {
    await lsp.dispose();                     // 停所有 LSP 服务、清计时器
  });
}
```

工具的 `execute` 闭包持有共享 `lsp`/ast-grep 解析器单例。

## 依赖增量

| 依赖 | 用途 | 类型 |
|------|------|------|
| `@ast-grep/cli` | `ast-grep`/`sg` 二进制解析 | dependencies |
| `vscode-jsonrpc` | LSP JSON-RPC 传输 | dependencies |
| `extract-zip` | GitHub 下载解压 | dependencies |

均为懒加载，不启用这些工具时无运行时开销。

## Out of Scope / P1

- LSP 健壮性：refcount 生命周期、init-reaping(60s)、capabilities 检测、post-edit `didChange` 同步（`tool_result` hook）
- ~~`@ast-grep/napi` 进程内后端~~（已评估放弃：napi 仅内置 ts/js，py/java/kotlin/c-c++ 需编译 tree-sitter 动态库，跨平台工程过重；CLI 已内置全部语言）
- `lsp_symbols` ast-grep fallback（本次明确不做）
- 更多语言（go/rust/ruby/php…）、更多服务器
- 写操作：`ast_grep_replace`、lsp rename
- `/lsp` inspector 命令
- 诊断、formatters、linters（pi-lens 领域）
- 自定义 renderResult TUI 渲染（P2）

## 与 Pi 内置工具的关系

| 场景 | 用哪个 | 原因 |
|------|--------|------|
| 按语法结构找代码 | `ast_grep_search` | 比 grep 精准，无假阳性，跨行 |
| 看文件结构 | `lsp_symbols` | 比 read 省 ~95% token |
| 查类型/文档 | `lsp_hover` | 无替代 |
| 定义在哪 / 谁在用 | `lsp_navigate` | 语义级精准，ast-grep 无法替代 |
| 纯文本/注释/日志 | 内置 `grep` | ast-grep 不匹配注释 |
| 读实现细节 | 内置 `read` | symbols 只给骨架 |
| 找文件名 | 内置 `find` | 专业分工 |
