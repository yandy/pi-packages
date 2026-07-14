# Design: pi-coding-tools 包

**Date:** 2026-06-21
**Status:** 已放弃（superseded）

> **⚠️ 已放弃（2026-06-24）**：本 spec 提出的 `apply_patch` 工具**未实现**（当前 pi-coding-tools 仅含 ls/find/grep 激活）。`apply_patch` 功能不再计划引入。pi-coding-tools 的后续演进见 [2026-06-24-pi-coding-tools-ast-lsp-design.md](./2026-06-24-pi-coding-tools-ast-lsp-design.md)（AST/LSP 代码理解工具）。本 spec 仅作历史归档保留。

## Summary

新建 `pi-coding-tools` pi 包，提供一个扩展，实现两个功能：

1. 注册 `apply_patch` 工具——支持 Codex 文本格式 patch（`*** Begin Patch` ... `*** End Patch`），通过 lark freeform grammar 让模型直接输出 raw patch 文本，无需 JSON 包装。支持文件的创建、更新、删除、移动操作，多文件一次应用。
2. 激活默认未激活的内置工具 `ls`、`find`、`grep`——在 `session_start` 事件中添加到激活工具集。

两个功能均通过配置文件控制是否启用，支持全局配置和项目级配置（项目级覆盖全局级），默认全部启用。

实现以 [code-yeongyu/pi-apply-patch](https://github.com/code-yeongyu/pi-apply-patch)（参考 3）为主干，保留其 patch 解析、路径安全、原子写入、完整 diff 渲染、失败恢复指令等全部核心逻辑。主要差异：移除参考 3 的条件激活/工具集同步/系统提示注入（改为无条件激活，不替换 edit/write），新增 ls/find/grep 激活、配置文件支持和单元测试。

## Scope

### 新建文件

| File | Purpose |
|------|---------|
| `pi-coding-tools/package.json` | 包元数据，`pi-package` 关键字，`pi.extensions: ["./index.ts"]`，peerDep `@earendil-works/pi-coding-agent`，dep `diff` |
| `pi-coding-tools/index.ts` | 扩展入口：加载配置，按配置注册 `apply_patch` 工具 + `session_start` 按配置激活 ls/find/grep |
| `pi-coding-tools/src/parse.ts` | Codex patch 文本解析 → `ParsedPatch[]`，lark grammar 定义，模糊匹配 `seekSequence` |
| `pi-coding-tools/src/apply.ts` | 应用 patch 到文件系统：路径安全、原子写入、`replaceChunks`、失败恢复指令 |
| `pi-coding-tools/src/render.ts` | TUI 渲染：diff 预览、行号、word-diff、语法高亮、背景色分层、进度更新 |
| `pi-coding-tools/src/apply-patch-tool.ts` | 工具定义：组合 parse/apply/render，导出 `createApplyPatchTool()`（含 execute/renderCall/renderResult） |
| `pi-coding-tools/src/write-file-atomic.ts` | 原子写入（temp 文件 + rename，Windows 兼容） |
| `pi-coding-tools/src/config.ts` | 配置加载：全局 `~/.pi/agent/coding-tools.json` + 项目级 `.pi/coding-tools.json`，项目级覆盖全局级 |
| `pi-coding-tools/src/search-tools.ts` | `enableSearchTools(pi, config)`：按配置激活 ls/find/grep |
| `pi-coding-tools/tsconfig.json` | 复用 pi-web-tools 配置 |
| `pi-coding-tools/vitest.config.ts` | 复用 pi-web-tools 配置 |
| `pi-coding-tools/biome.json` | 复用 pi-web-tools 配置 |
| `pi-coding-tools/AGENTS.md` | 指向 RELEASE.md |
| `pi-coding-tools/RELEASE.md` | 发布流程（`pi-coding-tools-v*` tag → GitHub Release → npm publish） |
| `pi-coding-tools/README.md` | 包说明 |
| `pi-coding-tools/tests/parse.test.ts` | 解析器单测 |
| `pi-coding-tools/tests/apply.test.ts` | 应用逻辑单测（临时目录） |
| `pi-coding-tools/tests/render.test.ts` | 渲染工具函数测试 |
| `pi-coding-tools/tests/config.test.ts` | 配置加载、合并、默认值单测 |

### 修改文件

| File | Change |
|------|--------|
| `.github/workflows/publish.yml` | case 语句添加 `pi-coding-tools-v*)` → `dir=pi-coding-tools` |
| `.github/workflows/test.yml` | paths-filter 添加 `pi-coding-tools` 分支 |

### 不涉及变更

- 不修改 pi-coding-agent 源码
- 不修改 pi-web-tools / pi-container-sandbox
- 不修改根 .gitignore

## Architecture

### 与参考 3 的差异

| 维度 | 参考 3 | 本方案 | 理由 |
|------|--------|--------|------|
| 激活策略 | 条件激活（按 provider+id 切换 edit/write ↔ apply_patch） | 无条件激活，不替换 edit/write | 用户需求是"提供一个 apply_patch tool"，不按模型切换 |
| 工具集同步 | `syncToolset()` 在 session_start/model_select/before_agent_start | 无 | 不条件激活，无需同步 |
| 系统提示注入 | 为 Codex 模型追加用法说明 | 无 | 不按模型区分，靠 promptSnippet + promptGuidelines |
| 额外功能 | — | 激活 ls/find/grep | 用户需求 2 |
| 配置支持 | — | 全局+项目级配置文件，控制各工具启用/禁用 | 用户需求 3 |
| 包名 | `@earendil-works/pi-coding-agent`（peerDep） | `@yandy0725/pi-coding-tools`，peerDep `@earendil-works/pi-coding-agent ^0.74.0` | monorepo 约定 |
| 测试 | 无 | `tests/` 含 parse/apply/render/config 单测 | TDD + monorepo 约定 |
| 文件组织 | `src/index.ts` + `src/write-file-atomic.ts`（2 文件） | `src/parse.ts` + `src/apply.ts` + `src/render.ts` + `src/apply-patch-tool.ts` + `src/write-file-atomic.ts` + `src/config.ts` + `src/search-tools.ts` | 参考三单文件 1200 行过大，拆分便于测试和维护 |

### 完全保留（与参考 3 一致）

- Patch 语法（Codex 文本格式）+ lark freeform grammar 定义
- `ParsedPatch` / `PatchChunk` 类型
- 模糊匹配 4 级降级（精确 → trimEnd → trim → Unicode 标准化）+ fuzz 分数
- 路径安全完整防护（realpath + workspace 边界 + 符号链接检查）
- 原子写入（temp + rename）
- 完整 diff 渲染（行号 + word-diff + 语法高亮 + 背景色分层）
- 失败恢复指令（mustReadFiles/mustNotReadFiles）
- `prepareArguments` 容错（string 或 {input}）
- 部分成功保留已写入变更
- `diff` npm 依赖（渲染用）

## Package Structure

```
pi-coding-tools/
├── package.json          # pi-package 关键字, pi.extensions: ["./index.ts"]
├── index.ts              # 扩展入口
├── src/
│   ├── parse.ts          # Codex patch 文本解析
│   ├── apply.ts          # 应用 patch 到文件系统
│   ├── render.ts         # TUI 渲染
│   ├── apply-patch-tool.ts   # 工具定义（组合 parse/apply/render）
│   ├── write-file-atomic.ts  # 原子写入
│   ├── config.ts         # 配置加载（全局+项目级）
│   └── search-tools.ts   # 激活 ls/find/grep
├── tests/
│   ├── parse.test.ts
│   ├── apply.test.ts
│   └── render.test.ts
├── tsconfig.json
├── vitest.config.ts
├── biome.json
├── AGENTS.md
├── RELEASE.md
└── README.md
```

### package.json 关键字段

```json
{
  "name": "@yandy0725/pi-coding-tools",
  "publishConfig": { "access": "public" },
  "version": "0.1.0",
  "description": "pi package providing apply_patch tool and enabling ls/find/grep built-in tools",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/yandy/pi-packages", "directory": "pi-coding-tools" },
  "type": "module",
  "keywords": ["pi-package"],
  "files": ["index.ts", "src/"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "biome lint .",
    "format": "biome format --write .",
    "check": "biome check ."
  },
  "pi": { "extensions": ["./index.ts"] },
  "peerDependencies": { "@earendil-works/pi-coding-agent": ">=0.74.0" },
  "dependencies": { "diff": "^7.0.0" },
  "devDependencies": {
    "@biomejs/biome": "^2.5.0",
    "@earendil-works/pi-coding-agent": "^0.74.0",
    "@types/diff": "^7.0.0",
    "@types/node": "^22.0.0",
    "typescript": "~5.7.0",
    "vitest": "^3.0.0"
  }
}
```

## Tool Signatures

### apply_patch 工具签名

```typescript
{
  name: "apply_patch",
  label: "ApplyPatch",
  description: "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
  promptSnippet: "Apply Codex-format file patches with apply_patch",
  promptGuidelines: [
    "Use apply_patch for file edits instead of mutating files through bash, Python scripts, heredocs, or shell redirection.",
    "After apply_patch succeeds, do not re-read the edited files just to confirm the patch applied."
  ],
  parameters: Type.Object({
    input: Type.String({ description: "The entire contents of the apply_patch command" })
  }),
  freeform: {
    type: "grammar",
    syntax: "lark",
    definition: APPLY_PATCH_LARK_GRAMMAR
  },
  prepareArguments: normalizeApplyPatchArguments
}
```

### 内置 edit/write 签名（参考对比，不修改）

- **write**: `{path: string, content: string}`，`resolveToCwd` 解析路径，mkdir + writeFile
- **edit**: `{path: string, edits: [{oldText, newText}]}`，`resolveToCwd` 解析路径，精确文本替换
- 两者路径策略：开放（允许绝对路径、`../` 穿越）

### apply_patch 路径策略（与 edit/write 不同）

`apply_patch` 比 edit/write 更强大（多文件、删除、移动），采用更严格的安全防护：

1. `realpath(cwd)` 解析工作目录真实路径
2. `path.resolve(workspacePath, filePath)` 计算绝对路径
3. `isPathWithinWorkspace()` 检查：拒绝结果路径在 workspace 之外
4. `findExistingAncestor()` 找到最近的现有祖先目录
5. `realpath(existingAncestor)` 验证祖先目录未通过符号链接逃逸
6. 任一检查失败 → 抛出 `PatchApplicationError`

## Patch Format

### Lark grammar 定义

```
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
```

### ParsedPatch 类型

```typescript
type ParsedPatch =
  | { type: "add"; filePath: string; content: string }
  | { type: "delete"; filePath: string }
  | { type: "update"; filePath: string; movePath?: string; chunks: PatchChunk[] };

type PatchChunk = {
  changeContexts: string[];
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
};
```

### 解析流程

1. `normalizePatchText`：CRLF → LF
2. `stripHeredoc`：检测并解包 `<<EOF ... EOF` 包裹（容错）
3. 验证信封：首行 `*** Begin Patch`，末行 `*** End Patch`
4. 逐行扫描 hunk 头：
   - `*** Add File: <path>` → 收集后续 `+` 开头行为文件内容
   - `*** Delete File: <path>` → 标记删除
   - `*** Update File: <path>` → 可选 `*** Move to: <path>`，然后收集 `@@` context + `+`/`-`/` ` 行
5. 每行前缀：`+` 新增、`-` 删除、` ` 上下文、`*** End of File` 标记 EOF 插入

### 模糊匹配（seekSequence，4 级降级）

1. 精确匹配 `line === pattern`（fuzz 0）
2. `trimEnd` 匹配（fuzz 1）
3. `trim` 匹配（fuzz 100）
4. Unicode 标准化匹配（全角→半角、智能引号→ASCII、特殊空格→空格）（fuzz 10000）

EOF chunk 从文件末尾向前搜索。每级返回 fuzz 分数用于结果汇报。

### 错误类型

- `PatchParseError`：语法错误（缺失信封、无效 hunk 头、行前缀非法）
- `PatchApplicationError`：应用错误（context 未找到、路径逃逸、文件不存在）
- `ApplyPatchError`：聚合错误，携带部分成功结果

## Application Logic

### applyParsedPatchDetailed(cwd, hunks, onProgress) → ApplyPatchResult

1. 顺序遍历 hunks，逐个应用
2. 每个 hunk 通过 `resolvePatchPath(cwd, filePath)` 解析路径
3. 按 hunk 类型执行：
   - **add**：`mkdir -p dirname` → `writeFileAtomic(absPath, content)`
   - **delete**：`stat(absPath)`（确保存在且非目录）→ `rm(absPath)`
   - **update**：`readFile` → `replaceChunks(content, filePath, chunks)` → `writeFileAtomic`；若有 `movePath`，写到新路径后删旧路径
4. 每个 hunk 独立 try/catch：失败记录到 `failures[]`，成功记录到 `appliedFiles[]`，不回滚已写入变更
5. 每个 hunk 完成后调用 `onProgress({applied, failed, total})` 用于 TUI 进度更新

### replaceChunks（update hunk 核心逻辑）

1. `splitFileLines(content)` 按行分割（去掉末尾空行）
2. 遍历 chunks，对每个 chunk：
   - 先用 `seekSequence` 匹配 `changeContexts`，推进 `lineIndex`
   - `oldLines.length === 0` → 末尾插入
   - 否则用 `seekSequence` 匹配 `oldLines`，记录 replacement `{start, oldLength, newLines}`
   - 末尾空行特殊处理（匹配失败时去掉再试一次）
3. 从后往前 `splice` 应用 replacements（避免索引偏移）
4. 累加 fuzz 分数

### 原子写入（write-file-atomic.ts）

```typescript
async function writeFileAtomic(absPath: string, content: string): Promise<void> {
  const tempPath = `${absPath}.tmp.${process.pid}.${random}`;
  await writeFile(tempPath, content, "utf-8");
  try {
    await rename(tempPath, absPath);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    await unlink(absPath);  // Windows 兼容：先删目标
    await rename(tempPath, absPath);
  }
}
```

### 失败恢复指令（createRecoveryInstructions）

```typescript
function createRecoveryInstructions({appliedFiles, failures}): ApplyPatchRecoveryInstructions {
  const mustReadFiles = [...new Set(failures.map(f => f.filePath))];
  const mustReadSet = new Set(mustReadFiles);
  const mustNotReadFiles = [...new Set(appliedFiles.filter(f => !mustReadSet.has(f)))];
  return { mustReadFiles, mustNotReadFiles };
}
```

失败时返回给模型：`"Recovery: MUST read <failed files> before retrying. MUST NOT reread other files..."`

### ApplyPatchResult 类型

```typescript
type ApplyPatchResult = {
  summaries: string[];
  appliedFiles: string[];
  failures: ApplyPatchFailure[];
  hasPartialSuccess: boolean;
  recoveryInstructions: { mustReadFiles: string[]; mustNotReadFiles: string[] };
  details: { fuzz: number };
};
```

## TUI Rendering

与参考 3 完全一致，无改动。包括：

- **renderCall**：参数未完成时显示 "apply_patch: Patching"；完成后从 patch 文本提取路径，显示 "apply_patch: Patching (N files): path1, path2"
- **renderResult**：
  - 有 preview 时：用 `Box` + 背景色分层（pending→`toolPendingBg`，success→`toolSuccessBg`），显示标题 + diff 预览
  - expanded 时渲染完整 diff：行号、`+`/`-`/` ` 符号、`renderDiff` 语法高亮、inline word-diff（`diff` npm 包 `diffWords`），removed/added 行分别用 `toolErrorBg`/`toolSuccessBg`
  - 非 expanded 时折叠显示文件摘要
- **进度更新**：`onProgress` 回调触发 `onUpdate`，显示 `(applied+failed/total)` 进度
- **diff 预览生成**：`createPatchPreview` 读取原文件，用 `Diff.diffLines` 生成行号 diff，`truncatePreview` 头尾截断（16 行/4000 字符上限，优先显示变更 hunk 附近上下文）
- **applyLayeredBackground**：处理 ANSI 转义码与背景色叠加

## Configuration

参考 [pi-web-tools/src/config.ts](https://github.com/yandy/pi-packages/blob/main/pi-web-tools/src/config.ts) 的配置模式。

### 配置文件位置

| Scope | Path | 说明 |
|-------|------|------|
| 全局 | `~/.pi/agent/coding-tools.json` | `getAgentDir()` + 文件名 |
| 项目级 | `<cwd>/.pi/coding-tools.json` | `CONFIG_DIR_NAME` + 文件名 |

项目级覆盖全局级（浅合并各字段）。

### 配置结构

```typescript
interface CodingToolsConfig {
  applyPatch: boolean;  // 默认 true
  ls: boolean;          // 默认 true
  find: boolean;        // 默认 true
  grep: boolean;        // 默认 true
}
```

### 配置文件示例

```json
{
  "applyPatch": true,
  "ls": true,
  "find": true,
  "grep": true
}
```

不配置文件时，四个工具全部启用（默认值）。项目级配置的某个字段会覆盖全局配置的对应字段，未覆盖的字段保持全局值或默认值。

### src/config.ts

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

interface CodingToolsConfig {
  applyPatch: boolean;
  ls: boolean;
  find: boolean;
  grep: boolean;
}

const DEFAULT_CONFIG: CodingToolsConfig = {
  applyPatch: true,
  ls: true,
  find: true,
  grep: true,
};

let cachedConfig: CodingToolsConfig | null = null;
let cachedCwd: string | null = null;

function readJsonFile(path: string): Partial<CodingToolsConfig> | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Partial<CodingToolsConfig>;
  } catch {
    return null;
  }
}

export function loadConfig(cwd?: string): CodingToolsConfig {
  const dir = cwd || process.cwd();
  if (cachedConfig && cachedCwd === dir) return cachedConfig;

  const agentDir = getAgentDir();
  const globalConfig = readJsonFile(resolve(agentDir, "coding-tools.json")) || {};
  const projectConfig = readJsonFile(resolve(dir, CONFIG_DIR_NAME, "coding-tools.json")) || {};

  cachedConfig = {
    applyPatch: projectConfig.applyPatch ?? globalConfig.applyPatch ?? DEFAULT_CONFIG.applyPatch,
    ls: projectConfig.ls ?? globalConfig.ls ?? DEFAULT_CONFIG.ls,
    find: projectConfig.find ?? globalConfig.find ?? DEFAULT_CONFIG.find,
    grep: projectConfig.grep ?? globalConfig.grep ?? DEFAULT_CONFIG.grep,
  };
  cachedCwd = dir;
  return cachedConfig;
}
```

### 行为

- `applyPatch: false` → 不注册 `apply_patch` 工具
- `ls: false` → 不添加 `ls` 到激活工具集
- `find: false` → 不添加 `find` 到激活工具集
- `grep: false` → 不添加 `grep` 到激活工具集
- 各字段独立控制，互不影响

## ls/find/grep Activation

### index.ts 入口

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApplyPatchTool } from "./src/apply-patch-tool";
import { enableSearchTools } from "./src/search-tools";
import { loadConfig } from "./src/config";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  if (config.applyPatch) {
    pi.registerTool(createApplyPatchTool());
  }

  pi.on("session_start", async (_event, _ctx) => {
    enableSearchTools(pi, config);
  });
}
```

> 注：`createApplyPatchTool` 定义在 `src/apply-patch-tool.ts`，内部组合 parse.ts、apply.ts、render.ts 的函数。该文件是参考 3 `src/index.ts` 的等价物（工具定义 + execute + renderCall + renderResult），拆分出来以保持 index.ts 精简。该文件属于集成层，不在单测范围内（见 Testing Strategy）。

### search-tools.ts

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CodingToolsConfig } from "./config";

export function enableSearchTools(pi: ExtensionAPI, config: CodingToolsConfig): void {
  const allTools = new Set(pi.getAllTools());
  const current = new Set(pi.getActiveTools());
  const desired = [
    { name: "ls", enabled: config.ls },
    { name: "find", enabled: config.find },
    { name: "grep", enabled: config.grep },
  ] as const;
  for (const { name, enabled } of desired) {
    if (enabled && allTools.has(name) && !current.has(name)) {
      current.add(name);
    }
  }
  pi.setActiveTools([...current]);
}
```

关键点：
- 用 `getAllTools()` 验证名称有效性——如果某个名称不是内置工具，跳过
- 用 `getActiveTools()`/`setActiveTools()` 增量添加，不覆盖现有激活状态
- 在 `session_start` 触发，每个会话都会按配置激活
- 按配置字段决定是否激活，默认全部启用


## Testing Strategy

遵循 TDD：先写测试，再写实现。使用 vitest（monorepo 约定）。

### tests/parse.test.ts — 解析器单测（纯函数，无文件系统）

- 信封验证：缺失 `*** Begin Patch`/`*** End Patch` 抛 `PatchParseError`
- Add hunk：单文件、多文件、空内容
- Delete hunk
- Update hunk：无 context、有 `@@ context`、`*** Move to`、`*** End of File`
- 行前缀：`+`/`-`/` ` 正确分类到 `newLines`/`oldLines`
- Heredoc 解包：`<<EOF ... EOF` 包裹的 patch
- CRLF 归一化
- 空 patch（`*** Begin Patch\n*** End Patch`）抛错
- 无效 hunk 头抛错

### tests/apply.test.ts — 应用逻辑单测（临时目录，真实文件系统）

- 使用 `mkdtemp` 创建隔离临时目录，测试后清理
- Add：创建新文件、创建嵌套目录、覆盖已存在文件
- Delete：删除文件、删除不存在文件抛错、删除目录抛错
- Update：精确匹配替换、模糊匹配（trimEnd/trim/Unicode 标准化）
- Update + EOF：末尾插入
- Update + Move：移动并修改
- 部分成功：第一个 hunk 成功、第二个失败 → `hasPartialSuccess: true`，已写入文件保留
- 路径安全：绝对路径逃逸抛错、`../` 穿越抛错、符号链接逃逸抛错
- `recoveryInstructions`：`mustReadFiles` = 失败文件，`mustNotReadFiles` = 成功文件
- fuzz 分数累加

### tests/render.test.ts — 渲染测试

- `truncatePreview`：短文本不截断、长文本头尾截断、变更 hunk 附近上下文优先
- `extractPatchedPaths`：从 patch 文本提取路径
- `formatPatchPreview`：单文件/多文件摘要格式
- `createPatchDiff`：行号 diff 生成、added/removed 计数
- 渲染快照（`toMatchSnapshot`）：折叠/展开两种模式

### tests/config.test.ts — 配置测试

- 无配置文件时返回默认值（四个工具全部 true）
- 全局配置文件存在时读取全局值
- 项目级配置文件存在时覆盖全局值
- 部分字段配置：未配置字段保持默认值
- 配置文件 JSON 解析失败时回退到默认值
- 按 cwd 缓存：相同 cwd 返回缓存结果

### 不测试的部分（集成层，需 pi 运行时）

- `renderCall`/`renderResult` 的实际 TUI 输出（依赖 pi-tui 组件）
- `pi.registerTool`/`pi.setActiveTools` 的注册行为
- `session_start` 事件触发

### 覆盖率目标

- `parse.ts` 和 `apply.ts` 核心逻辑 >90%
- `render.ts` 工具函数 >80%

## CI Integration

### .github/workflows/publish.yml

case 语句添加：
```yaml
pi-coding-tools-v*)
  echo "dir=pi-coding-tools" >> "$GITHUB_OUTPUT"
  ;;
```

### .github/workflows/test.yml

paths-filter 添加：
```yaml
pi-coding-tools:
  - "pi-coding-tools/**"
```

## Release Flow

与 sibling 包一致：

```bash
cd pi-coding-tools
npm version <版本号> --no-git-tag-version
git add package.json package-lock.json
git commit -m "<版本号>"
git tag pi-coding-tools-v<版本号>
git push origin main --tags
gh release create pi-coding-tools-v<版本号> --title "pi-coding-tools v<版本号>" --notes ""
```

发布到 `@yandy0725/pi-coding-tools@X.Y.Z`（public access）。
