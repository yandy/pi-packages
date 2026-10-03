# Design: pi-memory 移除包级开关 `enabled`

**Date:** 2026-10-03
**Status:** approved

## Summary

`memory.json` 的顶层 `enabled` 是 12 个 pi package 里唯一的「包级自禁用开关」。本设计把它**整体删除**，让「是否加载 pi-memory」只由 pi 层决定（`packages` 过滤或卸载），与其他包一致：

1. **schema 删除**：`MemoryConfig` 不再有 `enabled`；`DEFAULT_CONFIG` 不再有 `enabled: true`；`requiredModels()` 不再按它豁免 dream —— dream 恒为必需任务。
2. **会话状态收敛**：三种（未启动 / 配置错误 / `enabled: false` 禁用）→ 两种（未启动 / 配置错误）。`memory` 工具的 `Memory is disabled — …` 文案与 `/memory` 的 disabled 分支（变死代码）一并删除。
3. **`/memory` 输出**：健康会话不再输出状态首行（原 `Memory: enabled`），改为 `Dir:` 起头共 7 行；配置错误态**保留** `Memory: misconfigured` 首行（可识别关键词）。
4. **零运行时迁移提示**：残留的 `enabled` 键按未知键忽略（与 v1 的 `maxTopicBytes` 先例一致），不检测、不提示、不主动剥离；迁移指引只写在 README。

三项已锁定决策（brainstorming Phase 2）：

| 决策 | 取值 |
|------|------|
| 动机 | 一致性/去特例：禁用统一由 pi 层负责 |
| 已有用户配置 | 硬删 + **零**运行时提示（仅文档） |
| 交付范围 | 代码 + 测试 + 文档；不动 `version`、不写版本化 breaking 块、不做 npm 发布 |

## Scope

### Deliverable

分支 `pi-memory-remove-package-switch`：代码、测试、文档改完并通过验证。是否创建 PR / 合并由 finishing 阶段单独决定。

### 不涉及变更

- **版本号与发布**：不动 `pi-memory/package.json` 的 `version`、不动 `package-lock.json`、不写 README 的版本化破坏性变更块（`**In 2.x:**` 条目）、不创建 tag / Release。历史破坏性变更块条目保持原样（它们是历史记录）。
- `autoSurfacing.enabled` / `extractMemories.enabled` / `defaults.sessionPersistence.enabled` 等**模块级**开关：全部保留。本设计只删**包级**总开关。
- `loadConfig()` 的合并逻辑与未知键容忍行为：不动。`deepMerge` 会把残留的 `enabled` 原样带到运行时对象上，但没有任何代码再读它（同 `maxTopicBytes` 先例）。
- `MemoryStore`、`paths.ts`、`sanitize.ts`、`session-search`、dream / extract / auto-surfacing 的内部行为。
- `docs/superpowers/specs/` 下的历史 spec（含描述 `enabled` 的旧文档）：保持原样。
- 历史 spec/README 中「1.x 数据」「模型必须显式配置」等既有语义：不变。

### Files to modify

| File | Change |
|------|--------|
| `pi-memory/src/config.ts` | `MemoryConfig` 删 `enabled`；`DEFAULT_CONFIG` 删 `enabled: true`；`requiredModels()` 删 `if (!cfg.enabled) return []` 与相关注释 |
| `pi-memory/index.ts` | 删 `ENABLE_HINT`、`getUnavailableMessage` 的 disabled 分支、`session_start` 的 `if (!loaded.enabled) return`、`before_agent_start` / `session_compact` / `agent_end` 守卫里的 `!config?.enabled \|\|`、`/memory` 的 disabled 分支与状态首行；更新所有 disabled 相关注释 |
| `pi-memory/src/memory-tool.ts` | 注释：「三种状态」→ 两种（未启动 / 配置错误）；无逻辑改动 |
| `pi-memory/tests/config.test.ts` | 删 `enabled` 默认值与合并断言、删「requires nothing when memory is disabled」用例 |
| `pi-memory/tests/index-wiring.test.ts` | 删 3 条 disabled 语义用例；~5 条「用 disabled 造无 store 会话」的用例改用配置错误路径；新增残留键忽略的回归钉子；更新 `/memory` 输出断言（8 行 → 7 行） |
| `pi-memory/tests/memory-tool.test.ts` | verbatim unavailable 用例的文案换成 misconfigured 文案 |
| `pi-memory/README.md` / `README.zh.md` | 配置示例、配置表、模型表、`/memory` 输出示例与说明、新增「禁用本扩展 / Disabling」短节 |
| `pi-memory/tests/manual-test-plan.md` | **删除该文件**（final review 后用户决定：手动测试计划不再维护） |

## Design

### 1. 删除 `enabled` 的 schema 与读点

```ts
// src/config.ts —— 改后
export interface MemoryConfig {
    // 无 enabled
    defaults?: DefaultsConfig;
    memoryDir: string;
    ...
}

export const DEFAULT_CONFIG: MemoryConfig = {
    // 无 enabled
    defaults: { sessionPersistence: { enabled: false } },
    ...
};

export function requiredModels(cfg: MemoryConfig): Array<{ task: ModelTask; value: string | undefined }> {
    // 原 `if (!cfg.enabled) return [];` 删除：dream 恒为必需任务
    const out = [{ task: "dream", value: taskModel(cfg, "dream") }];
    if (cfg.extractMemories.enabled) out.push({ task: "extractMemories", value: taskModel(cfg, "extractMemories") });
    if (cfg.autoSurfacing.enabled) out.push({ task: "autoSurfacing", value: taskModel(cfg, "autoSurfacing") });
    return out;
}
```

`index.ts` 删除的读点（全部为 6 处）：

| 位置 | 现状 | 改后 |
|------|------|------|
| `getUnavailableMessage` | `configError ? … : config?.enabled === false ? "Memory is disabled — …" : null` | `configError ? … : null` |
| `session_start` | `config = loaded; if (!loaded.enabled) return;` | `config = loaded;`（直接进入校验/初始化） |
| `before_agent_start` | `if (!config?.enabled \|\| !memoryDir \|\| !activeStore) return;` | `if (!memoryDir \|\| !activeStore) return;` |
| `session_compact` | `if (!config?.enabled \|\| !activeStore) return;` | `if (!activeStore) return;` |
| `agent_end` | `if (!config?.enabled \|\| !dir \|\| !activeStore) return;` | `if (!dir \|\| !activeStore) return;` |
| `/memory` handler | `!dir \|\| !activeStore` 时按 `configError` 二选一输出；健康分支首行 `Memory: ${config.enabled ? "enabled" : "disabled"}` | 只保留 misconfigured 输出（disabled 分支为死代码，删除）；健康分支删首行，改为 `Dir:` 起头 |

随之更新的注释（这些位置当前按「三态」措辞，改后为两态）：

| 位置 | 现措辞要点 |
|------|-----------|
| `resetSessionState()` 上方 | 「三条早退路径（disabled / 配置错误 / 初始化失败）共用」→ 两条 |
| `initMemory()` 上方 | 「调用方已确认 `config.enabled`」→ 调用方已通过模型校验 |
| `session_start` 内 | 「状态已经干净，disabled 直接早退即可」→ 删该句 |
| `/memory unlock` 分支 | 「以 disabled 启动的会话也要能清锁」→ 配置错误的会话 |
| `/memory` 状态分支 | 「否则只可能是配置里 enabled 为假」→ 删该句 |
| `src/memory-tool.ts` L72 / L203 | 「三种状态：未启动 / 配置错误 / `enabled: false` 的禁用会话」→ 两种；「配置错误或禁用的会话」→ 配置错误的会话 |

`/memory` 的 disabled 分支为什么是死代码：`config` 非 null 而 `store` 为 null 只可能来自 `session_start` 的三条路径 —— `failConfig`（置 `configError`）、`initMemory` 成功（置 `store`）、`initMemory` 抛错（走 `failConfig`）。移除 `enabled` 后不存在第四种路径，故 `configError === null` 时 `store` 必非 null。

**残留键的处理（决策 ②）**：不新增任何检测代码。`loadConfig` 读到 `{"enabled": false}` 时 `deepMerge` 照旧把它带进运行时对象，但类型上没有该字段、没有任何读点 —— 与 v1 遗留键 `maxTopicBytes` 的处理完全一致。

### 2. 会话状态与 `/memory` 输出（精确格式，供测试断言）

| 状态 | 触发 | `/memory` 输出 |
|------|------|----------------|
| 未启动 | `session_start` 尚未跑完（`config === null`） | `Memory not initialized.` 单行 |
| 配置错误 | 模型缺失/不可解析，或初始化失败（`configError` 非空） | `Memory: misconfigured` + `Dir: not initialized` + 每问题一行 `- <error>` |
| 健康 | 其他 | 7 行，`Dir:` 起头（见下） |

健康态输出（顺序与现行一致，仅去掉首行；行数 8 → 7）：

```
Dir: <memoryDir>
Index: <n>/<memIndexMaxLines> lines, <n>/<memIndexMaxBytes> bytes, <n> unrecognized lines
Inject: <n>/<memIndexInjectMaxLines> lines, <n>/<memIndexInjectMaxBytes> bytes
Entries: <n>
Modules: dream=on(<model>) extractMemories=off autoSurfacing=on(<model>)
Last dream: <ISO | never>
Lock: <free | unreadable — run /memory unlock | held by …>
```

`Memory: misconfigured` 保留为错误态首行（可搜索的关键词；错误态与健康态因此不同形）。`session_start` 的 error 通知 `pi-memory config error:` 不变，仍是主信号。

`memory` 工具的不可用文案只剩一条来源：配置错误 → `Memory not initialized — <首行错误>; run /memory for details`。`Memory is disabled — set "enabled": true in memory.json and restart` 消失。

### 3. 语义后果与接受的代价

- **dream 模型恒需**：任何健康会话都要求 `dream.model` 或 `defaults.model` 可解析。此前 `enabled: false` 的会话可以完全免配模型。
- **升级用户**：`memory.json` 里写着 `{"enabled": false}` 且没配模型的用户，升级后首启会收到 `pi-memory config error: - no model for dream — set "dream.model" or "defaults.model" in memory.json`，之后 `/memory` 报 `Memory: misconfigured`。这是「一致性」的代价，按决策 ② **不加**运行时提示。
- **禁用方式变化**：想禁用必须改用 pi 层（见 §4）。扩展一旦加载就恒为「开启」，模块级开关仍可单独关掉 auto-surfacing / extract。

### 4. 禁用路径（替代方式，写入 README）

项目级（`.pi/settings.json`，需项目信任）：

```json
{ "packages": [{ "source": "npm:@yandy0725/pi-memory", "extensions": [] }] }
```

依据：pi docs `packages.md` —— 「同一 package 同时出现在个人与项目 settings 时，项目条目替换个人条目」（`autoload: false` 才是过滤 delta）。该写法此前已实测可阻止扩展加载；`pi config -l` 会写出等价配置。全局禁用用 `pi remove npm:@yandy0725/pi-memory` 或 `pi config` 的资源开关（`pi config` 在项目 scope 会写成 `autoload: false` + `extensions: ["-index.ts"]` 的等价禁用形态）。

### 5. 测试策略

**删除**（语义已不存在）：

- `tests/config.test.ts`：`DEFAULT_CONFIG.enabled` 断言、`cfg.enabled` 断言、「requires nothing when memory is disabled」用例。
- `tests/index-wiring.test.ts`：`/memory reports the disabled switch when the session booted disabled`、`reports nothing when memory is disabled even with no models configured`、`tells the tool caller that memory is disabled after a disabled restart`。

**改写**（把 `enabled: false` 换成配置错误，继续钉同一批行为）：这些用例原本只是**借** disabled 造一个「无 store 的会话」，断言对象是跨 session 复位与 unlock，与开关无关。改用「`defaults` 无 model → `failConfig` → `resetSessionState`」造同样的前置状态：

- `/memory unlock reports an unresolvable memory dir instead of throwing`
- `/memory unlock removes the lock in a session that booted disabled` → 「…in a misconfigured session」
- `/memory unlock still asks first when the session booted disabled` → 同上
- `/memory after a disabled restart never reports or unlocks the previous session's dir` → 用配置错误造 storeless 重启（核心断言不变：不得碰到上一 session 的 dir）
- `/dream refuses right after a disabled restart instead of dreaming the old dir` → 同上
- `clears the injected-file set on every session_start` → 用 `defaults` 有/无 model 交替造两次重启
- extract 失败通知的「配额跨 session 重置」用例（`session_start` 提前 return 的那段）→ 用配置错误重启

**更新**：`/memory` 状态输出用例（8 行 → 7 行，首行断言由 `Memory: enabled` 改为 `Dir:`，其余行号整体上移）；`tests/memory-tool.test.ts` 的 verbatim 用例换成 misconfigured 文案。

**新增**（钉死本次移除）：`memory.json` 写 `{"enabled": false}` → 会话仍正常初始化（store 建立、工具注册、无任何通知、`/memory` 报健康 7 行）。这条同时是「不做运行时提示」的回归钉子。

### 6. 文档

`README.md` 与 `README.zh.md`：

- 配置示例 JSON 删 `"enabled": true,`；配置表删 `enabled` 行。
- 模型表 dream 行条件由「记忆系统开启（`enabled: true`）时恒需要」改为「恒需要（会话初始化即校验）」；删「`enabled: false` 时什么都不跑，因此不需要任何模型」句。
- `/memory` 输出示例删 `Memory: enabled` 首行（改为 `Dir:` 起头 7 行）；错误态示例保留 `Memory: misconfigured`。
- 删「以 `enabled: false` 启动的会话」条目与 `/memory on|off` 相关历史措辞里对当前行为无效的部分；功能列表里 `/memory` 的 “switch” 措辞去掉。
- **新增「禁用本扩展 / Disabling」短节**：§4 的两种写法 + 一句「≤2.3.x 的 `enabled` 键已不再生效（写它不会禁用扩展）」。

`tests/manual-test-plan.md`：**删除该文件**（2026-10-03 final review 后用户决定：该手动测试计划不再维护，不再随行为同步）。

## 风险

| 风险 | 处理 |
|------|------|
| 升级用户（`enabled: false` + 无模型）首启看到模型报错，信息不指向真正原因 | 决策 ② 明确接受；README「禁用本扩展」短节给出替代方式与键失效说明 |
| 用户以为 `{"enabled": false}` 仍能禁用 → 记忆静默启用 | 同上；并有回归测试钉死「残留键被忽略」这一事实 |
| 删除 `enabled` 后某处仍有隐式依赖（如 `/memory` 的 `!dir \|\| !activeStore` 分支） | §2 已论证该分支为死代码；改写后的 unlock/复位用例覆盖两条 storeless 路径 |
| 测试改动把「跨 session 复位」的承重断言换成假承重 | 改写只替换**造前置状态的手段**，断言逐条保留；`/dream` 用例要求 `confirm === true` 的既有注释保持 |
| 残留键在 `deepMerge` 后进入运行时对象，未来被误读 | 类型上无该字段（编译期拦住新读点）；验收标准第 3 条要求标识符在 `src/` 与 `index.ts` 中除注释外消失 |

## 验收标准

1. `MemoryConfig`、`DEFAULT_CONFIG`、`requiredModels()` 中不存在 `enabled`（包级）；`requiredModels()` 恒含 dream。
2. `index.ts` 中不存在 `ENABLE_HINT`、`config?.enabled`、`loaded.enabled` 任何读点；`Memory is disabled` 文案在 `src/`、`index.ts`、`tests/` 中消失。
3. `/memory` 健康态输出恰为 7 行且首行为 `Dir:`；配置错误态首行仍为 `Memory: misconfigured`。
4. `memory.json` 写 `{"enabled": false}` 的会话正常初始化、零通知，且有测试钉住。
5. 模块级开关（`autoSurfacing.enabled` / `extractMemories.enabled` / `sessionPersistence.enabled`）行为不变，其既有测试全绿。
6. `npm test -w pi-memory`、`npm run typecheck`、`npm run lint` 全绿；全仓 `npm test` 只允许 pi-container-sandbox 的 2 个已知环境性失败（无 podman/docker）。
7. `README.md` / `README.zh.md` 与新行为一致，并含「禁用本扩展 / Disabling」短节；`tests/manual-test-plan.md` 已删除。
8. 未改动 `pi-memory/package.json` 的 `version`，未新增版本化破坏性变更块。
