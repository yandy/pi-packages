# Design: pi-memory 简化 — 删除 on/off、model 必须显式配置、删除 1.x 自动迁移

**Date:** 2026-10-02
**Status:** approved

## Summary

pi-memory 承担了三件可以整体移除的东西：会话中途开关记忆的命令、内置的默认模型与「解析不出就退回父会话模型」的兜底、以及 1.x → 2.0 的自动迁移。本设计把三者一次性删掉，让行为边界变硬：

1. **命令面收窄**：`/memory on` / `/memory off` 删除。`enabled` 退化为**纯配置文件开关**（改了要重启会话），不存在任何中途启用路径。
2. **模型必须显式配置**：记忆不再是「装上就能跑」。`defaults.model` 或 per-task `model` 必须能解析出真实模型，否则 `session_start` 直接报错并且**本会话完全不初始化**（无 store、不注册 `memory` 工具）。父模型回退彻底删除。
3. **不再自动迁移 1.x 数据**：`src/migrate.ts` 整个删除。老的 topic 文件留在磁盘上，对记忆系统不可见（实测见 §4），需要人工转换。

## Scope

### Deliverable

分支 `refactor/pi-memory-simplify` 完成代码、测试、文档后**创建 GitHub PR**（合并与否则由用户决定）。

### 不涉及变更

- **版本号与 npm 发布**：本分支不动 `pi-memory/package.json` 的 `version`、不动 `package-lock.json`、不创建 GitHub Release。本次是破坏性变更（命令面 + 必需配置），发布时按 `docs/guides/release.md` 走 major 版本，属后续独立任务。
- `enabled` 配置项本身（保留，仅语义变为「只能从配置文件切换」）。
- `memory` 工具的 action 集合与 schema（仍是主 agent / extract 5 个、dream 7 个）。
- `MemoryStore`（读写原语、锁、快照、索引）、`paths.ts`、`sanitize.ts`、session-search 的内部行为。
- `src/snapshot.ts` 中 `migrate-` 前缀不参与裁剪的豁免（见 §4.3）。
- 对 legacy 文件的检测/告警/隐藏：**不做**。文件留在磁盘，不检测、不提示、不参与记忆视图。
- `docs/superpowers/specs/` 与 `docs/superpowers/plans/` 下的历史文档（含描述迁移的旧 spec）保持原样。
- 主 agent 自身会话的模型选择（`ctx.model` 与 pi 的模型切换逻辑不受影响）。

### Files to modify

| File | Change |
|------|--------|
| `pi-memory/index.ts` | 删除 `/memory on\|off` 分支与中途初始化/回滚逻辑、迁移调用与 `Migration:` 状态行；新增模型校验与初始化失败的统一错误态；删除 `parentModel` 传参 |
| `pi-memory/src/config.ts` | `DEFAULT_CONFIG.defaults` 去掉 `model`；新增纯函数 `requiredModels()` / `modelConfigErrors()` 与 `requiredModel()`；`resolveDefault()` 去掉 `model` 重载；更新注释中的「回退父模型」描述 |
| `pi-memory/src/model-resolver.ts` | 保持 `resolveModel()` 签名不变（注释里的「caller falls back to parent model」改为报错） |
| `pi-memory/src/agent-runner.ts` | `model` 变为必填 `string`，删除 `parentModel`；解析失败抛错 |
| `pi-memory/src/dream.ts` / `src/extract.ts` / `src/inject.ts` | 删除 `parentModel` 参数与透传 |
| `pi-memory/src/memory-tool.ts` | 删除 `getEnabled` 依赖与 `"Memory is disabled (run /memory on)"` 守卫 |
| `pi-memory/src/migrate.ts` | **删除文件** |
| `pi-memory/tests/migrate.test.ts` | **删除文件** |
| `pi-memory/tests/config.test.ts` | 新增 `modelConfigErrors()` / `requiredModels()` 用例；更新默认值断言 |
| `pi-memory/tests/index-wiring.test.ts` | 删除 on/off 与迁移用例；新增 disabled / misconfigured / 模型校验用例 |
| `pi-memory/tests/memory-tool.test.ts` | 去掉 `getEnabled`，保留 store 未初始化的守卫用例 |
| `pi-memory/tests/agent-runner.test.ts` | 删除父模型回退用例；新增「解析失败抛错」用例 |
| `pi-memory/tests/dream.test.ts` / `extract.test.ts` / `inject.test.ts` | 删除 `parentModel` 相关断言与传参 |
| `pi-memory/README.md` / `README.zh.md` | 命令表、配置表、模型语义、删除「从 1.x 迁移」章节与迁移锁说明、补 legacy 数据说明 |
| `pi-memory/tests/manual-test-plan.md` | 删除迁移/on-off 步骤，补模型校验人工验证步骤 |

## Design

### 1. 命令面：删除 `/memory on` / `/memory off`

`/memory` 只剩两种行为：

| 用法 | 行为 |
|------|------|
| `/memory`（或任何未识别参数） | 打印状态 |
| `/memory unlock` | 清崩溃遗留的 `.lock`（先确认，行为不变） |

`enabled` 的语义变化：

- 只从 `memory.json`（全局 `~/.pi/agent/memory.json`、受信任项目的 `.pi/memory.json`）读取。
- 会话启动时读一次；中途改文件不影响本会话，需要重启会话。
- `enabled: false` 启动的会话：不解析记忆目录、不建 store、不注册 `memory` 工具、extract 与 auto-surfacing 都不跑，**模型校验也不跑**（没有任何子任务会执行）。

`/memory` 在这种会话里的输出（精确两行，供测试断言）：

```
Memory: disabled
Dir: not initialized — set "enabled": true in memory.json and restart
```

被删除的代码（不再有任何调用点）：

- `index.ts` 中 `/memory` handler 的 `on` / `off` 分支，含 `initMemory` 返回值检查与「回滚 `enabled`」的分支。
- `initMemory` 的 `Promise<boolean>` 契约：改为 `Promise<void>`，只负责「建立本 session 运行时」，不再承担「能不能建」的判定（判定上移到调用方）。
- `memory-tool.ts` 的 `MemoryToolDeps.getEnabled` 与 `"Memory is disabled (run /memory on)"` 守卫。删除中途启用后，工具存在必然意味着 store 存在，这条守卫不可达；`getStore() === null` 的 `"Memory not initialized"` 守卫保留（防御性）。
- `index.ts` 中为「中途 `/memory on`」写的跨 session 状态复位注释与 `/memory unlock` 的 store-less 说明仍成立（unlock 依旧不依赖 store），仅删去与 on/off 相关的措辞。

### 2. 模型必须显式配置

#### 2.1 默认值

`DEFAULT_CONFIG.defaults` 里删除 `model`（保留 `sessionPersistence`）。`dream.model` / `extractMemories.model` / `autoSurfacing.model` 本来就是 optional，保持不变。

#### 2.2 需要模型的任务

| 任务 | 何时需要 | 解析顺序 |
|------|----------|----------|
| `dream` | **总是**（无开关；`/dream` 与 nudge 都可能触发） | `dream.model` → `defaults.model` |
| `extractMemories` | 仅当 `extractMemories.enabled === true` | `extractMemories.model` → `defaults.model` |
| `autoSurfacing` | 仅当 `autoSurfacing.enabled === true` | `autoSurfacing.model` → `defaults.model` |

因此「只填 `defaults.model`」即可满足三者；per-task 键只在需要覆盖时才写。

#### 2.3 校验（fail-fast，双重）

`session_start` 且 `enabled: true` 时，在建立 store **之前**校验：

1. **键存在**：`requiredModels(cfg)` 得到的每个任务，解析值不得为 `undefined`。
2. **可解析**：解析值经 `resolveModel(value, ctx.modelRegistry)` 必须返回模型。

任一失败 → 报错 + **本会话完全不初始化**：不解析目录、不建 store、不注册 `memory` 工具、extract 与 auto-surfacing 都不跑。错误信息记录在工厂作用域（`configError`），使 `/memory` 能重复显示，直到用户修好配置并重启会话。

错误文案（精确，供测试断言）：

- 键缺失：`no model for <task> — set "<task>.model" or "defaults.model" in memory.json`
- 不可解析：`model "<value>" for <task> is not resolvable (unknown id or missing credentials)`

通知形态：`ctx.ui.notify(text, "error")`，文本为 `pi-memory config error:` 后跟一行一条 `- <error>`。

`/memory` 输出（`n + 2` 行，`n` = 错误条数）：

```
Memory: misconfigured
Dir: not initialized
- no model for dream — set "dream.model" or "defaults.model" in memory.json
```

#### 2.4 初始化失败也走同一错误态

现在 `session_start` 直接 `await initMemory(...)`，`resolveMemoryDir()` / 索引构建抛错会冒泡给宿主。改为 `try/catch`：失败时写 `configError`（`Failed to initialize memory: <message>`）、发 error 通知、清理本 session 状态，`/memory` 按 §2.3 的 `Memory: misconfigured` 形态显示。三种早退路径（disabled / 校验失败 / 初始化失败）共用同一个状态复位逻辑（清 `memoryDir` / `store` / `indexSnapshot` / `injectedFiles`），避免残留上一 session 的项目状态。

#### 2.5 删除父模型回退

- `src/agent-runner.ts`：`model?: string` → `model: string`；删除 `parentModel`；解析失败（`resolveModel` 返回 `undefined`）直接抛 `model "<value>" is not resolvable (unknown id or missing credentials)`。启动校验之外仍保留这层抛错，覆盖「会话中途凭据被移除」等注册表变化 —— 结果是显式失败，而不是静默用错模型。
- `src/dream.ts` / `src/extract.ts` / `src/inject.ts`：删除 `parentModel` 选项与透传；`RunDreamOpts.model` / extract / `runSideQuery` 的 model 参数变为必填 `string`。
- `index.ts`：删除三处 `parentModel: ctx.model` 传参（dream 调用、extract 调用、surfacing 调用）。`ctx.model` 在 pi-memory 内不再被读取。
- `src/config.ts` / `src/model-resolver.ts` 的注释同步：不再提「回退父会话模型」。

#### 2.6 校验逻辑的落点与可测性

`src/config.ts` 新增两个纯函数（不依赖 SDK 的 registry 类型）：

```ts
export type ModelTask = "dream" | "extractMemories" | "autoSurfacing";

/** 会执行的任务及其解析后的模型值（per-task 优先，其次 defaults.model）。 */
export function requiredModels(cfg: MemoryConfig): Array<{ task: ModelTask; value: string | undefined }>;

/**
 * 校验所需模型：键存在 + resolve 成功。
 * `resolve` 由调用方注入（生产时是 `(v) => resolveModel(v, ctx.modelRegistry) !== undefined`），
 * 因此本函数是纯函数，可用假 resolve 单测。
 */
export function modelConfigErrors(
  cfg: MemoryConfig,
  resolve: (value: string) => boolean,
): string[];
```

`modelConfigErrors` 对 `enabled: false` 直接返回 `[]`（不会执行任何任务）。

调用点取值用第三个函数，避免 `model: string | undefined` 在类型上漏下去：

```ts
/** 已通过启动校验的任务模型值；缺失时抛错（真正守卫在启动校验，这里是防御）。 */
export function requiredModel(cfg: MemoryConfig, task: ModelTask): string;
```

`index.ts` 的三处调用（dream 的 nudge 路径与 `/dream` 命令、extract、surfacing）改用 `requiredModel(config, <task>)`，`resolveDefault()` 只保留 `sessionPersistence` 这一个重载（不再有 `model` 分支），其返回值类型收窄为 `SessionPersistenceConfig | undefined`。

### 3. 测试策略

每个任务按 TDD 先写失败测试。用例清单：

**`tests/config.test.ts`**（纯函数，注入假 `resolve`）

1. `enabled: false` + 三个键全空 → `modelConfigErrors` 返回 `[]`。
2. `enabled: true` + 只有 `dream.model` → 仍报 `extractMemories` / `autoSurfacing` 缺失（两者默认 enabled）。
3. `extractMemories.enabled = false` + `autoSurfacing.enabled = false` + 只有 `dream.model` → `[]`。
4. 只填 `defaults.model` → 三个任务都满足（`[]`）。
5. per-task 覆盖 `defaults.model`（值出现在错误信息里的是 per-task 值）。
6. `resolve` 恒 false → 三条 `not resolvable` 错误，信息含具体值。
7. `DEFAULT_CONFIG.defaults.model` 为 `undefined`（防止默认值悄悄回来）。

**`tests/index-wiring.test.ts`**

8. `/memory` 在 disabled 会话输出精确两行（`Memory: disabled` + 新提示），且**不含** `run /memory on`。
9. `enabled: false` 的会话：`session_start` 不注册工具、不建目录；模型键为空也不报错。
10. `enabled: true` 且 `dream` 无模型 → 一条 error 通知、注册工具数为 0、`/memory` 输出 `Memory: misconfigured` + 精确错误行。
11. 模型不可解析（假 registry 里没有该 id）→ 同样的错误态，信息含值。
12. 只填 `defaults.model` → 正常初始化（工具注册、索引注入照常）。
13. `/memory on` / `/memory off` 不再是子命令：参数照样落到状态分支（`on` 不初始化、`off` 不改变 `enabled`）。
14. legacy topic 文件躺在记忆目录里 → 启动无迁移通知、不写 `.migrated`、`/memory` 无 `Migration:` 行；目录内容不被改动。
15. 删除现有 on/off 用例（`index-wiring.test.ts:898`、`1496`、`1632` 附近、`1683`、`1725`、`1831`）与三个迁移用例（`1308`–`1340` 附近），其中 unlock 相关用例保留。

**`tests/memory-tool.test.ts`**：构建工具不再需要 `getEnabled`；`getStore() === null` 时 `list` 抛 `Memory not initialized`。

**`tests/agent-runner.test.ts`**：删除父模型回退用例；新增解析失败抛错用例；正常路径仍用显式配置的模型（断言传给 `createAgentSession` 的 model）。

**`tests/dream.test.ts` / `extract.test.ts` / `inject.test.ts`**：删除 `parentModel` 传参与断言；model 值原样透传到 runner。

**`tests/snapshot.test.ts`**：`migrate-` 豁免用例保留不动。

**验证**：`npm run typecheck && npm run lint && npm test`（根目录，含所有 workspace）。

### 4. 删除 1.x → 2.0 自动迁移

#### 4.1 删除清单

- `src/migrate.ts`（`MIGRATED_FILE`、`MIGRATE_LOCK_TIMEOUT_MS`、`isLegacyTopicFile`、`parseLegacyEntries`、`migrateIfNeeded` 等全部导出）。
- `index.ts`：`import { MIGRATED_FILE, migrateIfNeeded }`、`readMigrationStatus()`（约 72–95 行）、`initMemory` 内的迁移 `try/catch` 与通知、`/memory` 状态里的 `Migration:` 行。
- `tests/migrate.test.ts`。
- `index-wiring.test.ts` 的三个迁移用例。
- 提到迁移的注释：`src/dream.ts` 的 `snapshotFiles` 说明（`.migrated` 不再存在，改为只提 `.lock` / `.dream-meta.json`）、`src/memory-store.ts:20` 与 `:51` 的迁移引用。

#### 4.2 行为

- 记忆目录里存在 legacy topic 文件（v1 frontmatter：有 `updated`、无 `created`/`modified`）时，**没有任何动作**：不解析、不切分、不删除、不备份、不通知、不写标记。
- 用户升级到本版本后，记忆内容与磁盘文件一个字节都不变。
- `/memory` 状态行从 7 行变 6 行（去掉 `Migration:`）。

#### 4.3 保留 `migrate-` 快照豁免

`src/snapshot.ts#pruneSnapshots` 跳过 `migrate-` 前缀目录，`tests/snapshot.test.ts` 的对应用例保留。理由：已经跑过 2.x 迁移的用户，其 `.backups/migrate-<ts>/originals/` 是 2.x 之前数据的**唯一副本**；删除豁免会让后续任何一次写入把它裁掉（`lock.snapshotKeep` 默认 5）。豁免不产生新目录，代价为零。

#### 4.4 legacy 文件的实际结局（已实测）

`parseEntryFile()` 要求 v2 frontmatter 五字段齐全，v1 文件返回 `null`；`MemoryStore.listEntries()` / `searchEntries()` 对解析失败的文件静默跳过。一次性测试实测确认：

- v1 topic 文件（`type` + `updated`，无 `created`/`modified`，含两个 `## ` 段）→ `listEntries()` 与 `searchEntries()` 均返回空。
- 正文含多个 `## ` 段的**合法 v2 entry** 照常可见（不会被误判为 legacy）。

因此 legacy 内容**静默不可达**：不出现在索引、注入、`list` / `read` / `search` 里，`/dream` 也看不见（dream 只能通过 `memory` 工具访问，没有文件工具）。本设计接受这个代价并写进 README；不提供检测与迁移工具。人工转换方式（文档一句话）：按 v2 entry 格式补 frontmatter、按 `## ` 段拆成独立文件，或从 `.backups/migrate-*/originals/` 取回原文。

### 5. 文档

- `README.md` 与 `README.zh.md` 同步：
  - 命令表：`/memory` 只剩 status 与 `unlock`；`/memory on|off` 删除。
  - 配置表：`enabled` 行的说明改为「只在启动时读取，改动需重启会话」；`defaults.model` / `dream.model` / `autoSurfacing.model` / `extractMemories.model` 的默认值列改为「无默认值」，说明「必需（可由 `defaults.model` 提供），否则启动报错」。
  - 新增一节「模型配置」：fail-fast 语义、`/memory` 的 `Memory: misconfigured` 输出示例、需要模型的任务与 disabled 任务的豁免规则。
  - 删除「从 1.x 迁移」整节、配置表里迁移 30s 锁的措辞、以及其它「自动迁移」描述；新增一段「1.x 数据」说明（不自动迁移、文件对工具不可见、人工转换建议、`.backups/migrate-*/` 保留）。
  - 删除正文里 `run /memory on` 之类的措辞（如 disabled 会话说明、锁失败提示）。
- `tests/manual-test-plan.md`：删除迁移与 on/off 步骤，新增「缺模型 / 错模型 / 只配 defaults.model」的人工验证。

## 风险

| 风险 | 处理 |
|------|------|
| 升级用户未配模型 → 记忆整块不可用（刻意 fail-fast） | 错误文案直接给出两个可写的键名；README 把模型配置提到显眼位置；`/memory` 重复显示错误 |
| `resolveModel` 走 `getAvailable()`（只含已配置凭据的模型），未登录的 provider 会被判为不可解析 | 文案用 `unknown id or missing credentials` 覆盖两种原因 |
| 用户以为 1.x 数据还在用 | README 明确「不迁移 + 工具不可见」；`.migrated` 标记文件对系统已无意义 |
| 已迁移用户的 `.backups/migrate-*` 被裁剪 | 保留 `pruneSnapshots` 的 `migrate-` 豁免及其测试 |
| 会话中途凭据/注册表变化导致解析失败 | `agent-runner` 抛错，不回退父模型（显式失败优于静默用错模型） |

## 验收标准

1. `/memory` 只有状态与 `unlock` 两种行为；代码中不存在 `on` / `off` 分支与中途初始化路径。
2. `enabled: true` 且任一**会执行**的任务缺少/无法解析模型 → 本会话不初始化，且错误在通知与 `/memory` 中都可见。
3. 只填 `defaults.model` 时三个任务都通过校验；被 disabled 的任务不要求模型。
4. 代码中不存在 `parentModel` 回退（标识符在 `index.ts` / `src/` 中消失）。
5. 代码中不存在 `migrate` 相关路径（`src/migrate.ts` 已删，无任何引用 `.migrated`）；legacy 文件不引发任何动作。
6. `npm run typecheck && npm run lint && npm test` 全绿（报告实际用例数）。
7. README.md / README.zh.md / manual-test-plan.md 与新行为一致。
8. 分支创建 GitHub PR。
