# Design: pi-coding-tools — ast_grep_replace (AST-aware rewrite)

**Date:** 2026-06-24
**Status:** draft

## Summary

为 `@yandy0725/pi-coding-tools` 包新增 `ast_grep_replace` 工具，实现 **AST-aware rewrite**：基于 ast-grep 的 meta-variable 模式匹配并替换代码，**默认 dry-run**（只预览不写盘），通过 `apply` 参数才真正写入文件。

复用现有 `ast_grep_search` 的基础设施（二进制解析、语言推断、pattern-hints），新增轻量 rewrite 执行层与 before→after 预览格式化。向后兼容，新增 config 开关 `ast_grep_replace`（默认启用）。

### 关键决策摘要

| 决策 | 结论 | 理由 |
|------|------|------|
| apply 机制 | **单工具 + `apply` boolean 参数（默认 false）** | 直接贴合「dry-run by default」语义，调用简单；apply=false 预览不写盘，apply=true 用 `-U` 写盘 |
| dry-run 输出格式 | **before→after 列表**（按文件分组） | 省 token，与现有 `formatSearchResult` 风格一致；unified diff 对多行改动冗长 |
| 核心层组织 | **新建 `src/ast-grep/rewrite.ts`**，复用 `getAstGrepPath`/`inferLangFromPath` | 与 `search.ts` 同构，职责分离；不污染既有 search 路径 |
| 类型策略 | **新增 `CliRewriteMatch`/`SgRewriteResult`**，不改既有 `CliMatch`/`SgResult` | dry-run JSON 含 `replacement`/`replacementOffsets` 额外字段；独立类型避免破坏 search 解析 |
| 安全限制 | **不设硬性改动数阈值** | dry-run 即为预览/确认，apply 返回改动数；额外阈值属过度设计（YAGNI） |
| 正则误用提示 | **复用现有 `getPatternHint`** | rewrite 与 search 共享 pattern 语义，无需另造提示逻辑 |

### CLI 行为依据（已实测验证）

- `ast-grep run -p PATTERN -r REWRITE --lang LANG --json=compact [paths]`（**不带** `-U`）= **dry-run**：输出含 `replacement`、`replacementOffsets`、`metaVariables` 字段的 JSON 数组，**不修改文件**，exit 0。
- 追加 `-U`（`--update-all`）= **apply**：写盘并输出 JSON（`-U` 与 `--json` 可共存，需在 TDD 阶段确认写盘生效；若不生效则 apply 改走 `-U` 单用 + 解析 "Applied N changes"）。
- 无效 pattern / rewrite 引用不存在的 meta-var → 输出 `[]`，exit 0（不崩溃）。
- 不存在的 path → stderr `ERROR: ... No such file`，stdout `[]`，exit 0。

## Scope

### 新建文件

| File | Purpose |
|------|---------|
| `pi-coding-tools/src/ast-grep/rewrite.ts` | `runAstGrepRewrite(options)`：构建 `-p/-r/--json=compact`(+`-U`) args，spawn+timeout，`parseRewriteStdout` 解析含 `replacement` 的 JSON |
| `pi-coding-tools/src/tools/ast-grep-replace.ts` | `ast_grep_replace` 工具定义（pattern/rewrite/lang/path/apply 参数 + execute） |
| `pi-coding-tools/tests/ast-grep/rewrite.test.ts` | `parseRewriteStdout` 单测（含 replacement 字段、空/非法 JSON） |
| `pi-coding-tools/tests/ast-grep/rewrite.integration.test.ts` | 真二进制：dry-run 不写盘、apply 写盘 |

### 修改文件

| File | Change |
|------|--------|
| `pi-coding-tools/src/ast-grep/types.ts` | 新增 `CliRewriteMatch`、`SgRewriteResult`、`RunSgRewriteOptions` 类型（不改既有类型） |
| `pi-coding-tools/src/formatters.ts` | 新增 `formatRewriteResult(result)`：dry-run before→after / apply 摘要 / no-match / error |
| `pi-coding-tools/src/config.ts` | `CodingToolsConfig` + `DEFAULT_CONFIG` 加 `ast_grep_replace: true`；`loadConfig` 加合并行 |
| `pi-coding-tools/src/search-tools.ts` | `ALL_TOOL_NAMES` 加 `"ast_grep_replace"` |
| `pi-coding-tools/index.ts` | import + `pi.registerTool(ast_grep_replace)` |
| `pi-coding-tools/tests/tools-registration.test.ts` | mock rewrite 层，测 dry-run/apply/binary 缺失 |
| `pi-coding-tools/tests/search-tools.test.ts` | 配置补 `ast_grep_replace` 字段 |
| `pi-coding-tools/tests/config.test.ts` | `baseTrue` 补 `ast_grep_replace` |
| `pi-coding-tools/tests/formatters.test.ts` | `formatRewriteResult` dry-run/apply/no-match/error |
| `pi-coding-tools/README.md` | 工具表与 config 字段表加 `ast_grep_replace` |

## 设计细节

### 工具参数 schema

```ts
{
  pattern: string;   // 必填，AST 模式（$VAR / $$$），与 search 相同
  rewrite: string;   // 必填，替换串，可引用 meta-variable，如 "logger.info($MSG)"
  lang?: string;     // 可选，省略则按 path 扩展名推断
  path?: string;     // 可选，文件或目录，默认 cwd
  apply?: boolean;   // 可选，默认 false；false=dry-run 不写盘，true=-U 写盘
}
```

### execute 流程

1. `path = params.path ?? ctx.cwd`
2. `lang` 推断：`params.lang`（校验 `isCliLanguage`，非法→返回 unsupported）→ 否则 `inferLangFromPath(path)` → 兜底 `typescript`
3. `runAstGrepRewrite({ pattern, rewrite, lang, paths:[path], apply })`
4. `text = formatRewriteResult(result)`
5. 无匹配且无 error → 追加 `getPatternHint(pattern, lang)`
6. 返回 `{ content:[{type:"text", text}], details }`

### `runAstGrepRewrite` 实现

- 复用 `getAstGrepPath()`；缺失 → 返回 `error: INSTALL_HINT`
- args：`["run","-p",pattern,"-r",rewrite,"--lang",lang,"--json=compact", ...paths]`，`apply` 追加 `["-U"]`
- spawn + 30s timeout（与 `search.ts` 同构），收集 stdout/stderr
- `code !== 0 && !stdout.trim()`：stderr 含 "No files found" → 空结果；否则 `error: stderr`
- `parseRewriteStdout(stdout)` 解析 JSON 数组，校验每条含 `replacement` 字段
- 返回 `SgRewriteResult { matches, totalMatches, truncated, applied }`

### `formatRewriteResult` 输出

**dry-run（applied=false）**：
```
3 match(es) • 2 file(s) [dry-run, no files written]
src/index.ts (2 matches)
  src/index.ts:5:1  - console.log("hi")
                    + logger.info("hi")
  src/index.ts:12:1  - console.log("world")
                     + logger.info("world")
src/util.ts (1 match)
  src/util.ts:8:1  - console.log("top")
                   + logger.info("top")
```

**apply（applied=true）**：
```
Applied 3 change(s) across 2 file(s)
src/index.ts (2 changes)
src/util.ts (1 change)
```

**无匹配**：`No matches found`（工具层追加 pattern hint）
**error**：`Error: <msg>`

### 配置

`coding-tools.json` 新增字段（默认 `true`），与现有工具同机制（全局 + 项目覆盖）：

```jsonc
{
  "ast_grep_replace": true
}
```

## 验收标准

1. `ast_grep_replace` 工具注册成功，出现在 `pi.getActiveTools()`。
2. dry-run（`apply` 缺省/false）：不修改任何文件，返回 before→after 预览 + 文件/匹配计数。
3. apply（`apply=true`）：实际写盘，返回 `Applied N change(s) across M file(s)` + 每文件改动数。
4. 无效 pattern/rewrite（如引用不存在的 meta-var）：返回空结果 + pattern hint，不崩溃。
5. 二进制缺失：返回 INSTALL_HINT。
6. `ast_grep_replace` 可在 config 中开关（默认启用）。
7. 全部测试通过：`npm test`、`npm run typecheck`、`npm run check`。

## YAGNI 取舍

- **不加硬性改动数阈值**：dry-run 已是预览/确认，apply 返回改动数；阈值属过度设计。
- **不引入 unified diff**：按确认决策用 before→after 列表，省 token 且风格统一。
- **不另造 pattern 提示**：复用 `getPatternHint`。
- **apply 阶段不另设二次确认机制**：dry-run 即确认步骤；agent 可先 dry-run 再 apply。

## 风险

| 风险 | 缓解 |
|------|------|
| `-U` + `--json=compact` 同用时是否真写盘未 100% 确认 | TDD 阶段用集成测试验证写盘；若不生效，apply 改走 `-U` 单用 + 解析 "Applied N changes" 行 |
| apply 写盘为破坏性操作 | 默认 dry-run；apply 显式 opt-in；返回改动数便于回滚判断 |
