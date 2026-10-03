# Design: pi-coding-tools — 收敛为「只提供额外工具」及工具启用模型决策

**Date:** 2026-10-03
**Status:** implemented（0.6.0，已发布）

## Summary

`@yandy0725/pi-coding-tools` 原本做两件事：提供 5 个自定义 AST/LSP 工具，**外加**在 `session_start` 激活默认关闭的内置 `ls`/`find`/`grep`（并可用 `coding-tools.json` 反向关闭）。本设计把包收敛为**只提供额外工具**：不再读写任何内置工具，只注册自己的 5 个工具。

破坏性变更，版本 `0.5.4 → 0.6.0`（0.x 按 minor 承载 breaking）。落地记录见本文末「实施与发布」。

### 关键决策摘要

| 决策 | 结论 | 理由 |
|------|------|------|
| 内置工具激活 | **删除**——包不再读写 `ls`/`find`/`grep` | 用户需求：包只提供额外工具。升级后这三个工具需用户自行在 settings 开启（见「迁移」） |
| 自定义工具启用模型 | **保留**自有逐工具开关（`coding-tools.json` 5 个布尔 + `refreshTools`） | 见下「为什么不用更简单的两种做法」——宿主既有机制无法提供可靠的逐工具关闭，而 opt-in 方案会把默认从全开变成全关 |
| 简化方案 A：纯注册即激活（pi-web-tools / pi-todo 的做法） | **否决** | 会丧失逐工具关闭能力；且不能用 `--exclude-tools` / `defaultTools` 的 `-name` 替代（宿主对扩展工具在启动时不生效，证据见下） |
| 简化方案 B：`defaultActive: false` + settings 的 `defaultTools: ["+name"]` opt-in | **否决** | 逐工具开关确实能回归 pi 原生设置，但默认从「全开」变成「全关」，是需要第二次迁移说明的行为变化；收益（省掉 `refreshTools`）不足以抵偿 |
| `refreshTools` 实现边界 | **主体不变**：读现有激活集 → 只增删自己管的 5 个工具 → 写回 | 由此「其他来源已激活的内置工具被原样保留」这一契约由实现天然满足（无需额外代码） |
| 旧配置兼容 | `ls`/`find`/`grep` 键**静默忽略** | `loadConfig` 是逐字段白名单构造，旧键结构上不可能被读到；不报错、不影响启动 |
| spec 记在哪 | 本文件（package 的 `docs/superpowers/specs/`），不入项目记忆 | 设计决策属仓库正式记录；记忆只承载跨会话的操作性事实 |

## 背景事实（决策依据，均已核对）

### 宿主如何决定工具激活（pi 1.0.0）

- `pi.registerTool` 会调用 `runtime.refreshTools()`（`dist/core/extensions/loader.js:240`），`direct` 工具**注册即激活**；这一激活路径在 `agent-session.js` 的 `_refreshToolRegistry` 里走「新注册的、activated-on-registration 的工具直接推进激活集」分支，**不经过** `_isAllowedTool`（允许/排除过滤）。
- 后果：对**扩展工具**而言，`--exclude-tools` 与 settings 的 `defaultTools: ["-name"]` 在启动时不可靠——注册路径会绕过它们。因此「删除包内开关、改用宿主排除」不成立（这也是最终审查阶段被列为 pre-existing 行为、未在 0.6.0 处理的一项）。
- `defaultActive?: boolean` 是公开字段（`dist/core/extensions/types.d.ts:473`）：「A tool with `defaultActive: false` is activated by naming it in `--tools` or the `defaultTools` setting, or with `setActiveTools()`。」→ 方案 B 的技术基础，语义确定但默认关。

### 本仓库其他包的启用模型（评估时的对照）

| 包 | 启用机制 |
|---|---|
| pi-web-tools / pi-todo | 无——只 `registerTool`，注册即激活 |
| pi-vision-tools | 无用户开关；`setActiveTools` 仅做「调用模型有视觉能力就关掉 `describe_image`」的能力门控 |
| pi-memory | 包级 `enabled`：`session_start` 里 enabled 才 `registerTool` |
| pi-coding-tools | **唯一**提供逐工具用户开关的包（本设计有意保留） |

## Scope

### 修改文件

| File | Change |
|------|--------|
| `src/config.ts` | `CodingToolsConfig` 去掉 `ls`/`find`/`grep` 三个字段；`DEFAULT_CONFIG` 与 `loadConfig` 合并逻辑同步收敛（5 个自定义工具开关 + `lsp` 块保持不变） |
| `src/search-tools.ts` | `ALL_TOOL_NAMES` 收敛为 5 个自定义工具；`refreshTools` 函数体不变 |
| `package.json` | version → `0.6.0`；description → AST/LSP 工具口径 |
| `index.ts` | **不改**（仍注册 5 个工具、`session_start` 调 `refreshTools`、`session_shutdown` 释放 LSP manager） |

### 测试

| File | Change |
|------|--------|
| `tests/config.test.ts` | 去掉 3 个字段；新增「legacy 键被忽略」用例 |
| `tests/search-tools.test.ts` | 收敛为 5 个工具；新增 hermetic 契约守卫：legacy 键即便为 `true` 也不得激活内置工具、不得关闭其他来源激活的 `grep` |
| `tests/extension-factory.test.ts` | 端到端断言改为「5 个自定义工具在激活集 + `grep` 保留 + `ls`/`find` 不被激活」；与真实 `~/.pi/agent` 隔离（mock `getAgentDir` + 临时 cwd）；补 `registers all five tools`（含 `ast_grep_replace`） |
| `tests/tools-registration.test.ts` | `baseTrue` 夹具去掉 3 个字段 |

### 文档

两版包 README 删除「启用内置工具」功能段与对应配置字段，补回 `lsp` 配置块形状示例（含 `command`/`env`），新增中英双语破坏性变更块；根两版 README 描述行与 `package.json` description 同步。

## 行为契约（0.6.0 起）

1. 本包**不激活**未激活的 `ls`/`find`/`grep`。
2. 其他来源（pi 设置 / 其他扩展）已激活的内置工具**被原样保留**——本包不关闭它们，旧的 `grep: false` 也不再有效。
3. 配置为 `false` 的**自定义**工具仍会从激活集移除（现有能力不回归）。
4. 旧配置里的 `ls`/`find`/`grep` 键不报错、不生效。
5. 扩展加载期不调用 action methods（`refreshTools` 仍只在 `session_start` 执行）。

## 迁移（面向用户）

pi 默认工具集只有 `read`/`bash`/`edit`/`write`，因此 0.6.0 之后 `ls`/`find`/`grep` 需要用户自己开启：

```json
{ "defaultTools": ["+ls", "+find", "+grep"] }
```

写在用户级 `~/.pi/agent/settings.json` 或项目级 `.pi/settings.json`；`+name` 形式在继承的默认集上追加。**该语法需要 pi ≥ 0.99**（`defaultTools` 设置 0.84.2 引入、`+name` 0.99.0 引入），而本包 peer 下限是 `>=0.80.2`——见「未决项」。

## 验证

- `pi-coding-tools`：13 文件 / **82 用例通过**；`tsc --noEmit`、`biome lint` 通过
- 仓库根：`typecheck` / `lint` / `check:dev-deps` / `check:host-deps` 通过；CI `test-full`、`lockfile-sync` 通过
- 行为脚本：初始激活集 `["read","bash","edit","write","grep"]` + 旧配置遗留键 `ls/find/grep: false` → 结果保留 `grep`、不含 `ls`/`find`、5 个自定义工具齐全
- 全仓 `npm test` 唯一失败为 `pi-container-sandbox` 的 2 个环境性用例（无 OCI runtime），在未改动的 main 上同样失败，非本变更引入

## 实施与发布

- 实施：SDD（subagent-driven）4 个任务 + 每任务独立审查 + 最终整分支 review（With fixes）→ 单个修正波 + scoped re-review 全部 ADDRESSED
- 合并：PR #169 squash → main `4e50a3e2`
- 发布提交：`73e99628 pi-coding-tools v0.6.0`（翻转两版 README 的「未发布」标注）
- Release：`pi-coding-tools-v0.6.0`（tag → `73e99628`），`publish.yml` 成功（provenance 已签名），npm `latest = 0.6.0`

## 未决项（parked，未阻塞 0.6.0）

| 项 | 状态 |
|---|---|
| README 迁移指引的 `+name` 语法需 pi ≥ 0.99，而 peer 下限 `>=0.80.2` | 已在 GitHub release notes 中注明；README 内未加版本注记。可选处置：加注记 / 抬高 peer 下限 / 接受 |
| `src/tools/lsp-tools.ts` 的 `promptGuidelines` 仍写 "use grep instead"，而 `grep` 不再由本包激活 | 措辞待维护者定夺（模型仍能看到真实工具列表，影响低） |
| `refreshTools` 会覆盖 `--tools` 排除、与其它扩展 `session_start` 的顺序耦合、`loadConfig` 按 cwd 缓存、`coding-tools.json` 未知键无校验 | pre-existing，本设计有意不动 |

## 与既有 spec 的关系

- 取代 `2026-06-21-pi-coding-tools-design.md` 中「激活默认未激活的内置工具 ls/find/grep」的部分（该 spec 已标注 superseded，且 `apply_patch` 未实现）。
- 补充 `2026-06-24-pi-coding-tools-ast-lsp-design.md` 的「三层代码理解工具集」：**文件级那一层（ls/find/grep）不再由本包提供**，AST/语义级 5 个工具与 `coding-tools.json` 开关保持不变。
