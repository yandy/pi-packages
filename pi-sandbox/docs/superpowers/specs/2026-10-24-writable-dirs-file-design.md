# pi-sandbox：`extraWritableDirs` 迁到独立文件 `sandbox-writable.json` 设计

日期：2026-10-24
状态：已批准
落点：`pi-sandbox/src/config.ts`、`tests/config.test.ts`、`tests/index-smoke.test.ts`、`README.md`、`README.zh.md`

## 1. 背景与目标

`extraWritableDirs`（v1.7.0 引入，见 `2026-10-14-extra-writable-dirs-design.md`）目前写在全局 `~/.pi/agent/sandbox.json` 里，与 `mode` / `runnerCommand` / `probeTimeoutMs` 这些安全关键项同处一份文件。

目标：把这份"用户授权目录清单"挪到独立文件 `~/.pi/agent/sandbox-writable.json`，去掉根 key，内容就是一个 JSON 数组，便于手工编辑与脚本追加；`sandbox.json` 回到四字段。仍然**只支持全局**（2026-10-14 决策不变：项目级文件不参与解析）。

非目标：不改授权语义（哪些目录可写、怎么规范化）、不加项目级文件、不加配置热重载、不改 `/permission` 的显示规则、不改四个后端的接线。

## 2. 用户已确认的决策

| 问题 | 决定 |
|---|---|
| 文件形态 | 独立 **JSON** 文件，无根 key，顶层就是一个字符串数组 |
| 文件名 | `~/.pi/agent/sandbox-writable.json`（经 `getAgentDir()` 解析） |
| 作用域 | 仅全局；`<cwd>/.pi/sandbox-writable.json` **静默忽略**（与 `sandbox.json` 同款） |
| `sandbox.json` 里的旧字段 | **告警并忽略**（`sandbox: ignoring "extraWritableDirs" in …/sandbox.json (moved to …/sandbox-writable.json)`），与 1.x `image`/`runtime`/`host` 段同款 |
| 内部接线 | 方案 A：`SandboxConfig` 类型不变，`extraWritableDirs` 在 `loadSandboxConfig()` 内从新文件合并进来 |

## 3. 配置契约

`~/.pi/agent/sandbox-writable.json`：

```json
["~/.cache/uv", "~/.local/share/pnpm/store", "/srv/team-data"]
```

语义（除文件来源外与现状逐条一致）：

1. 顶层必须是字符串数组；缺失文件 → 空列表（不告警、不报错）。
2. 逐条：`~` / `~/…`（win32 `~\…`）展开 → 必须绝对路径 → 必须是已存在目录 → `realpathSync.native` 规范化 → 按 canonical 拼写去重（保持声明顺序）。
3. 单条不合格 → `console.warn` 并丢弃该条，其余照常生效（沿用 `resolveExtraWritableDirs`，不改其判定）。
4. 覆盖 pi agent 目录的条目仍**只告警、保留**。

失败分层（与 `sandbox.json` **互相独立**）：

| 情况 | 处理 |
|---|---|
| 文件缺失 | 空列表，静默 |
| JSON 损坏 / 顶层不是数组 / 含非字符串元素 | `console.warn` + 空列表 |
| 单条非绝对 / 不存在 / 不是目录 | `console.warn` + 丢弃该条 |

关键变化：这个字段的任何错误**都不再**让 `sandbox.json` 整份回落默认（旧行为是"取值不是字符串数组 → 整份配置回退"）。`mode` / `runnerCommand` / `probeTimeoutMs` 的校验与 fail-safe 路径不受新文件影响。

读取时机不变：`getSandboxConfig()` 进程内缓存一次，改文件需重启 pi；`resetSandboxConfigCache()` 同时清掉新文件的结果。

## 4. 接线（方案 A）

- `SandboxConfig` 与 `DEFAULT_SANDBOX_CONFIG` 的字段**不变**（`extraWritableDirs: []` 保留），注释注明来源是 `sandbox-writable.json`，是"两文件的合成视图"。
- `validateSandboxConfig(raw, source)` 删除该字段的解析；原始 `raw` 里出现该键时告警（迁移提示），然后在 1.x legacy 段同一处处理。
- 新增 `loadWritableDirs(source?)`：读文件 → 结构校验（失败即 warn + `[]`）→ 复用 `resolveExtraWritableDirs(entries, source)`。`source` 即新文件路径，供逐条告警定位。
- `loadSandboxConfig()` = `{ ...validateSandboxConfig(sandbox.json) , extraWritableDirs: loadWritableDirs() }`。
- 消费方零改动：`src/tools.ts` 的 4 处 `configForCall()`、`index.ts` 的 `/permission` 状态行继续读 `config.extraWritableDirs`。

## 5. 文档

`README.md` / `README.zh.md` 同步：

- 配置章节改为"读两个文件"：`sandbox.json`（四字段表，删掉 `extraWritableDirs` 行）+ 独立文件（裸数组示例、逐条语义、失败语义）。
- 「常见工具缓存目录」示例改为写到 `sandbox-writable.json`。
- 三档模式表里的 `extraWritableDirs` 措辞指向新文件。
- Security notes 的"不要授予 pi agent 目录"条目与缓存搬迁段落改成指向新文件。
- 迁移提示一句：旧 `sandbox.json` 里的该字段会被告警并忽略。
- 版本按 minor（配置位置变化；README 不放 changelog 块，GitHub Release notes 写迁移）。

## 6. 备选与被否

1. **纯文本、一行一个路径（`.txt`）**：更易于 `echo >>` 追加，但没有结构校验、`#` 注释/引号/转义全靠自造约定；用户改选 JSON 数组，否。
2. **继续放在 `sandbox.json`（不做拆分）**：用户明确要求分离，否。
3. **静默忽略旧字段**：用户会莫名失去已配好的授权且无从查起，否。
4. **旧字段仍参与合并（两份并集）**：留下两个真源，正是本次要消掉的东西，否。
5. **方案 B（`SandboxConfig` 严格只表示 `sandbox.json`，独立 loader + 独立缓存，消费方各取两份）**：类型更诚实，但把改动摊到 5 处消费点；两值总是一起用，收益不抵 diff，否。

## 7. 验证

`tests/config.test.ts`：

- 无任何文件 → `extraWritableDirs` 为空；
- 只写 `sandbox-writable.json` → 解析出规范化后的列表；`sandbox.json` 缺失时其余字段仍是默认；
- `~/` 展开、非绝对/不存在/非目录条目告警丢弃、realpath 去重（现有用例迁到新文件）；
- 文件损坏 / 顶层是对象 / 含非字符串元素 → 告警 + 空列表，且 `sandbox.json` 的 `mode` 等**照常生效**（钉住"失败不再连坐整份配置"）；
- `sandbox.json` 里写 `extraWritableDirs` → 一次告警、被忽略、新文件的值仍生效；
- 项目级 `.pi/sandbox-writable.json` → 静默忽略，即使全局文件缺失也不生效、不告警。

`tests/index-smoke.test.ts`：`/permission` 的 `extra writable:` 与 `(inactive: read-only)` 用例改写入新文件。

命令链：`npm test -w pi-sandbox`、`npm run typecheck -w pi-sandbox`、`npm run lint -w pi-sandbox` 全绿。
