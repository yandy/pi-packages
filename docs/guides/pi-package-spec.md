# Pi Package 规范

本文档是 monorepo 中所有 pi package 的统一规范。任何现有 package 的 **维护、重构、以及新建 package** 均以此文档为准。

## 目录

- [Packages 总览](#packages-总览)
- [通用约定](#通用约定)
- [Extension Package](#extension-package)
- [Pure Skills Package](#pure-skills-package)
- [CI/CD 集成](#cicd-集成)
- [依赖管理](#依赖管理)
- [发布流程](#发布流程)
- [附录 A：新建 Package 检查清单](#附录-a新建-package-检查清单)
- [附录 B：重构 / 迁移指南](#附录-b重构--迁移指南)

---

## Packages 总览

### 两种类型

| 类型 | 特征 | 适用场景 |
|------|------|----------|
| **Extension** | 有 TS 代码，`index.ts` 入口，注册工具/命令/hooks | 需要运行时逻辑的功能 |
| **Pure Skills** | 无代码，仅提供 `skills/` 目录 | 纯知识/指引类能力 |

---

## 通用约定

以下约定适用于 **所有** package，无论类型。

### 命名

- 目录名：`pi-<name>`，全小写，单词间用连字符分隔（kebab-case）
- npm 名：`@yandy0725/pi-<name>`
- scope 固定为 `@yandy0725`，所有 package 均为 public

### 必需文件

每个 package 至少包含：

| 文件 | 用途 |
|------|------|
| `package.json` | 包元信息、scripts、pi 字段 |
| `.gitignore` | 忽略 `node_modules/`、`*.tsbuildinfo` |
| `README.md` | 英文文档 |
| `README.zh.md` | 中文文档 |

README 至少包含：功能简介、安装方式、工具/命令/参数的完整列表、License。

包目录内 **不要** 放 `LICENSE` 文件，见下节。

### License：全仓单一来源

仓库根的 `LICENSE` 是全仓唯一的许可文件，**任何 package 都不得存自己的副本**。

- 根 `package.json` 的 `license` 字段（`"MIT"`）是全仓许可的唯一来源，且必须与根 `LICENSE` 正文一致
- 每个 package 的 `package.json` 必须声明与根 **完全相同** 的 `license` 值（不允许某个包自选其它许可）
- 发布时由 `prepack` 钩子把根 `LICENSE` 临时复制进包目录，`postpack` 删除；npm 会自动把包目录里的 `LICENSE` 打进 tarball（即使它不在 `files` 中），所以发布产物依然带许可文件

每个 package 的 `package.json` 必须包含这两个脚本：

```jsonc
"scripts": {
  "prepack": "node ../scripts/license.mjs",
  "postpack": "node ../scripts/license.mjs --remove"
}
```

忽略临时副本只需在**根** `.gitignore` 里写一条单层通配，不要在每个包重复：

```gitignore
# prepack 复制进各包目录的 LICENSE 副本（仅发布时生成，不得提交）
/*/LICENSE
```

`*` 不跨 `/`，所以这条只匹配 `<pkg>/LICENSE` 这一层：根 `LICENSE` 照常跟踪，`<pkg>/skills/<name>/LICENSE` 这类更深的第三方许可也不会被意外忽略。

为什么必须用钩子：npm 只打包以包目录为根的子树，`files` 不能引用上一级目录，符号链接指向包外的 `LICENSE` 也会被排除在 tarball 之外。

校验：`npm run check:license`（CI 中执行）检查上述所有项——根 `license` 与 `LICENSE` 正文一致、各包 `license` 与根一致、包内没有已提交的许可副本、磁盘上残留副本内容与根一致、`<pkg>/LICENSE` 被根 `.gitignore` 忽略、钩子已挂。

### package.json 公共字段

所有 package 的 `package.json` 必须包含以下字段：

```jsonc
{
  "name": "@yandy0725/pi-<name>",
  "publishConfig": { "access": "public" },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yandy/pi-packages",
    "directory": "pi-<name>"
  },
  "type": "module",
  "keywords": ["pi-package"]
}
```

`keywords` 中必须包含 `"pi-package"`，可追加领域相关关键词。

`license` 的值必须与根 `package.json` 一致（见 [License：全仓单一来源](#license全仓单一来源)）。

### Workspace 注册

在根 `package.json` 的 `workspaces` 数组中注册（按字母序）：

```json
"workspaces": [
  "pi-ask-user",
  "pi-coding-tools",
  "..."
]
```

---

## Extension Package

### 目录结构

```
pi-<name>/
├── .gitignore
├── README.md
├── README.zh.md
├── index.ts              # 入口，export default function(pi: ExtensionAPI)
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/                  # 源码
│   └── ...
├── tests/                # 测试，*.test.ts
│   └── ...
└── skills/               # (可选) 内置 skills
    └── <skill-name>/
        └── SKILL.md
```

### package.json

```jsonc
{
  "name": "@yandy0725/pi-<name>",
  "publishConfig": { "access": "public" },
  "version": "0.1.0",
  "description": "简短描述",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yandy/pi-packages",
    "directory": "pi-<name>"
  },
  "type": "module",
  "keywords": ["pi-package"],
  "files": [
    "index.ts",
    "src/"
    // + "skills/"  如果内置 skills
    // + "config/"  "schemas/"  "docker/"  按实际需要
  ],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "biome lint .",
    "format": "biome format --write ."
  },
  "pi": {
    "extensions": ["./index.ts"]
    // + "skills": ["./skills"]  如果内置 skills
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=1.5.0"
    // 视需要追加：@earendil-works/pi-tui、@earendil-works/pi-ai、typebox
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.2",
    "@types/node": "^22.0.0",
    "typescript": "~7.0.2",
    "vitest": "^3.0.0"
  }
}
```

#### `files` 字段

- 至少包含 `"index.ts"` 和 `"src/"`
- 有 skills 则追加 `"skills/"`
- 发布时需要携带的其他目录（`config/`、`schemas/`、`docker/` 等）也必须加入
- npm publish 只发布 `files` 中列出的内容

#### `pi` 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `extensions` | `string[]` | 入口文件路径，指向 `./index.ts` |
| `skills` | `string[]` | (可选) skills 目录，如 `["./skills"]` |

#### `scripts`

四个标准脚本必须存在，以便根目录的 `npm run <script> --workspaces` 统一调用：

| 脚本 | 作用 |
|------|------|
| `test` | `vitest run` |
| `test:watch` | `vitest` |
| `typecheck` | `tsc --noEmit` |
| `lint` | `biome lint .` |
| `format` | `biome format --write .` |

另外所有 package（含 Pure Skills）都必须挂发布用的许可钩子（见 [License：全仓单一来源](#license全仓单一来源)）：

| 脚本 | 作用 |
|------|------|
| `prepack` | `node ../scripts/license.mjs` |
| `postpack` | `node ../scripts/license.mjs --remove` |

### tsconfig.json

所有 Extension 包统一继承根配置：

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["index.ts", "src/**/*.ts"]
}
```

`tests/` 不在 `include` 中——vitest 自行处理类型检查。

### vitest.config.ts

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

### index.ts

入口文件 export 一个 default function，接收 `ExtensionAPI`：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // pi.registerTool({ ... })
  // pi.registerCommand("name", { ... })
  // pi.registerFlag("name", { ... })
  // pi.on("session_start", ...)
  // pi.on("before_agent_start", ...)
  // pi.on("agent_end", ...)
  // pi.on("session_shutdown", ...)
}
```

约定：
- 入口文件放在包根目录的 `index.ts`
- 也可在 `index.ts` 中 `export { default } from "./src/index.js"` 再导出
- 类型导入使用 `import type`，避免运行时依赖
- 源码放在 `src/`，按模块拆分

### 工具提示词（三通道）

`registerTool()` 有三处内容会进模型上下文，性质不同。写之前先确认内容落在对的那一处（详见 `docs/superpowers/specs/2026-10-30-tool-prompt-audit-and-remediation-design.md`）：

| 通道 | 宿主落点 | 成本形态 | 写什么 |
|---|---|---|---|
| `description` | 工具 schema（每请求 × 每工具） | 不跨工具去重 | 工具做什么、语法、允许值、默认值、返回值 |
| `promptSnippet` | system prompt 的 `Available tools`，渲染成 `- <name>: <snippet>` | 每请求一份 | 一行目录：≤100 字符、不写工具名、不写指令、不加句号 |
| `promptGuidelines` | system prompt 的 `Guidelines`，扁平追加 | **按精确字符串去重** | 行为纪律：何时用 A 而不是 B、必须遵守的流程 |

硬规则：

- **description 只写事实**：不写“何时该用”，不写跨工具策略，不写面向用户的说明；不复述参数（参数级细节放参数描述）。
- **guidelines 不写参数细节与工具语法**；同一句话不得同时出现在 description 与 guideline（两处各付一份，且把两处绑死）。
- **跨工具共享的规则必须来自同一字符串常量**：pi 只按精确字符串去重，换个措辞就等于付两份。参考 `pi-sandbox/src/tools.ts` 的 `ENV_REDIRECT_GUIDELINE`、`pi-coding-tools/src/tools/lsp-tools.ts` 的 `LSP_LANGUAGE_SERVER_GUIDELINE`。
- **覆盖内置工具必须用 `create*ToolDefinition`**：`create*Tool()` 返回的是 `AgentTool`，经 `wrapToolDefinition()` 只透传 `name/label/description/parameters/prepareArguments/executionMode`，**不透传 `promptSnippet` / `promptGuidelines`**；而宿主按名字覆盖后只从覆盖后的定义读提示词，不会回落到内置定义。用错会让内置工具从 `Available tools` 消失、内置纪律全部静默丢失（已退役的 `pi-container-sandbox` 曾因此丢 779 字符）。
- **`label` / `renderCall` / `renderResult` / 返回值 `details` 不进 LLM**：不要往那里搬提示词内容，也不要为了“省 token”去优化它们。
- **注意宿主限制**：用自定义 system prompt（`SYSTEM.md` / `--system-prompt`）时 `promptSnippet` 与 `promptGuidelines` 会被整体丢弃，只有 `description` 存活。所以硬约束不能只押在 guidelines 上。

回归闸门：每个 Extension 包写一个 `tests/prompt-meta.test.ts`，调用仓库根 `scripts/prompt-hygiene.ts` 的 `assertPromptHygiene({ pkg, budget, tools, authored })`。它检查 snippet 长度/前缀/标点/祈使句、单条 guideline 长度与逐字重复、以及包内三通道合计预算（去重后）。`budget` 用该包当前实测值向上取整，防漂移。

### UI 能力与跨模式降级

宿主只暴露两个粗粒度信号：`ctx.mode`（`"tui" | "rpc" | "json" | "print"`）与 `ctx.hasUI`。它们**不能**表达「某个 UI 方法在这个宿主里真的有用」——RPC 的 UI 支持是**分级**的，而 `hasUI` 在 RPC 下恒为 `true`。

依据（宿主 1.5.0）：`ctx.hasUI` 的实现是「uiContext 不是 noOpUIContext」（`dist/core/extensions/runner.js`），RPC 模式在 `bindExtensions()` 时传入了一个**真实**的 uiContext（`dist/modes/rpc/rpc-mode.js` 的 `createExtensionUIContext()`）；只有 print / json 模式不带 uiContext（`dist/modes/print-mode.js`），退回 noOp。所以 `hasUI === false` 只覆盖 print / json，**不**表示「RPC 里 UI 都可用」。宿主目前没有能力探测接口（没有 `capabilities` 集合），只能按下面两张表推导。

#### 判据表：按需求选信号

| 需求 | 相关方法 | 判据 | 不满足时怎么办 |
|---|---|---|---|
| 自定义组件 / overlay / widget 组件 / 页眉页脚 / 终端按键 | `custom`、`onTerminalInput`、`setWidget(factory)`、`setFooter`、`setHeader`、`setEditorComponent`、`addAutocompleteProvider` | **必须** `ctx.mode === "tui"` | 降级为纯文本（`notify`、`setWidget(string[])`，或整条跳过） |
| 弹对话框 | `select`、`confirm`、`input`、`editor` | 可以用 `ctx.hasUI`，但必须给 `timeout`（至少 `signal`） | 显式超时后按「用户取消」处理；**没有超时就会被无限挂住** |
| 一次性提示 / 状态标签 / 标题 / 编辑器文本 | `notify`、`setStatus`、`setTitle`、`setEditorText` | 两个信号都不够，只能 best-effort | 允许被静默丢弃，**功能正确性不得押在它们上** |
| 读回终端状态 | `getEditorText`、`getToolsExpanded`、`getAllThemes`、`getTheme`、`setTheme`、`pasteToEditor` | 不可依赖 | RPC 下返回空值 / `false` / `{ success: false }` |
| 完全没有 UI（print / json） | 全部 | `ctx.hasUI === false` | 必须有纯文本降级路径（参考 `pi-ask-user` 的 `"Ask requires interactive mode"`） |

两条硬规则：

- **不要用 `hasUI` 守卫终端组件。** 它在 RPC 下为真，守卫会放行，然后组件被静默丢弃：用户既看不到东西，也得不到任何提示。
- **`hasUI` 为真不代表对话框会被回答。** 请求只是转发给客户端，客户端可以不实现、也可以静默丢弃（实例：T3 Code 的 PiDriver 只处理 `notify` / `setStatus` / `select` / `confirm` / `input` / `editor`，其余一律 `logDebug("Ignoring pi extension UI update.")`）。

#### RPC 能力矩阵

逐条核对自 `dist/modes/rpc/rpc-mode.js` 的 `createExtensionUIContext()`（宿主 1.5.0）。

| 方法 | RPC 行为 | 扩展侧要求 |
|---|---|---|
| `select` / `confirm` / `input` | 发 `extension_ui_request`，等 `extension_ui_response`；支持 `signal` + `timeout` | 必须传 `timeout` |
| `editor` | 发请求后无限等待，**签名里没有 `opts`**（无法超时、无法中断） | 不可用；需要文本输入时改用带 timeout 的 `input` |
| `notify` / `setStatus` / `setTitle` / `set_editor_text` | fire-and-forget（`setEditorText` 走 `set_editor_text` 这条路） | 允许静默丢弃 |
| `setWidget(key, string[])` | 转发 `setWidget` 请求（`widgetLines`），客户端自行排版 | 可用，但宿主可丢弃 |
| `setWidget(key, factory)` | **不转发，静默丢弃** | 只在 `mode === "tui"` 分支使用 |
| `custom` | 立即 `return undefined` | 必须处理 `undefined`（`pi-ask-user` 在此退回 `select` / `input`） |
| `onTerminalInput` | 返回空 unsubscribe（无按键通道） | 只在 tui 使用 |
| `setFooter` / `setHeader` / `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` / `setHiddenThinkingLabel` / `setEditorComponent` / `addAutocompleteProvider` / `setToolsExpanded` | 全空实现 | 只在 tui 使用 |
| `getEditorText` | 返回 `""`（同步方法无法等 RPC 响应） | 不可依赖 |
| `getEditorComponent` / `getTheme` | `undefined` | 不可依赖 |
| `getAllThemes` | `[]` | 不可依赖 |
| `setTheme` | `{ success: false, error: "Theme switching not supported in RPC mode" }` | 不可依赖 |
| `getToolsExpanded` | `false` | 不可依赖 |
| `theme` | 返回宿主内置的静态默认主题，不是客户端配置的主题 | 只用来取色，不要当成「用户的主题」 |
| `pasteToEditor` | 退化为 `setEditorText` | —— |

#### README 声明

凡是调用 `ctx.ui.*`、或对 `ctx.mode` / `ctx.hasUI` 分支的包，必须在 `README.md` 与 `README.zh.md` 各写一节 **`## UI surface`** / **`## UI 能力`**，用一张三列表声明每个方法：

| 列 | 内容 |
|---|---|
| `Method` | 用到的方法名（可合并同判据的方法） |
| `Guard` | 守卫用的信号：``mode === "tui"`` / `hasUI` / `none` |
| `Outside TUI` | 非 TUI 宿主里的实际行为（转发后可能被丢弃、退回纯文本、静默无输出……） |

目的：安装者在选宿主（TUI / RPC / `-p`）之前就能知道某功能会退化到什么程度，不必翻源码。列名可本地化（中文 README 用「方法 / 守卫 / 非 TUI」），行内容两语言必须一致。样板见 `pi-todo/README.md` 的 `## UI surface` 与其 `src/` 里的 `refreshWidget`。

两个已踩过的反例，改包前先看一眼：

- `pi-todo` 的看板最初用 `if (!ctx.hasUI) return;` 守卫，RPC 下继续调 `setWidget(factory)`，结果在 Studio / T3 里完全不可见且无任何提示。现在按 `ctx.mode === "tui"` 分支：tui 走组件（需要 `render(width)` 才能按显示宽度裁行），其他模式走字符串数组，`/todos` 全量视图在非 tui 下退回一条 `notify`。
- `pi-sandbox` 的配置告警不能直写终端（`console.warn` 会被随后的 TUI 绘制覆盖），改为「缓冲 + `session_start` 时安装出口」：有 UI 就 `notify`，本进程从未出现过 UI（`-p` / JSON）才退 stderr，其余无 UI 会话（父会话是 TUI 的子会话）宁可留在缓冲里等下一个有 UI 的会话。

### 测试

- 文件放在 `tests/`，命名为 `<module>.test.ts`
- 框架为 `vitest`
- 配置文件和 vitest.config.ts 等基础设施约定见 [测试规范](testing.md)
- **环境隔离规范**（文件系统、环境变量、`getAgentDir` 等）统一维护在 [测试规范](testing.md)，所有测试必须遵循

### Skills（可选）

如果 Extension 包同时提供 skills：

- skills 放在 `skills/<name>/SKILL.md`
- `package.json` 中 `pi.skills` 需声明
- `files` 中需包含 `"skills/"`

---

## Pure Skills Package

### 目录结构

```
pi-<name>/
├── .gitignore
├── README.md
├── README.zh.md
├── package.json
├── scripts/            # (可选) 预处理脚本
│   └── download-skills.mjs
└── skills/
    └── <name>/
        └── SKILL.md
```

### package.json

```jsonc
{
  "name": "@yandy0725/pi-<name>",
  "publishConfig": { "access": "public" },
  "version": "0.1.0",
  "description": "简短描述",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yandy/pi-packages",
    "directory": "pi-<name>"
  },
  "type": "module",
  "keywords": ["pi-package", "<相关关键词>"],
  "files": ["skills/"],
  "scripts": {
    "download-skills": "node scripts/download-skills.mjs",
    "prepublishOnly": "npm run download-skills",
    "prepack": "node ../scripts/license.mjs",
    "postpack": "node ../scripts/license.mjs --remove"
  },
  "pi": {
    "skills": ["./skills"]
  }
}
```

### 与 Extension 的差异

Pure Skills 不需要：

- `index.ts`、`src/`、`tests/`
- `tsconfig.json`、`vitest.config.ts`
- `devDependencies`（无代码可构建/测试）
- `pi.extensions` 字段
- 根 `vitest.config.ts` 的 `projects`

### prepublishOnly

如有 `prepublishOnly` 脚本，它会在 `npm publish` 前自动执行，可用于下载/生成最新 skills。发布时无需本地额外步骤。

### 可选 peerDependencies

如果 skill 依赖某个 CLI（如 `@larksuite/cli`），使用 optional peerDependencies：

```json
"peerDependencies": {
  "@larksuite/cli": "*"
},
"peerDependenciesMeta": {
  "@larksuite/cli": { "optional": true }
}
```

---

## CI/CD 集成

新 package 需要在以下两处注册：

### publish.yml

在 `.github/workflows/publish.yml` 的 case 分支中添加（按字母序）：

```bash
pi-<name>-v*)
  echo "dir=pi-<name>" >> "$GITHUB_OUTPUT"
  ;;
```

### test.yml

在 `.github/workflows/test.yml` 的 `dorny/paths-filter` filters 中添加（按字母序）：

```yaml
pi-<name>:
  - "pi-<name>/**"
```

Pure Skills 类型虽无测试脚本，仍需添加 filters 条目，否则 PR 中不会触发 CI。

### vitest.config.ts（仅 Extension）

在根 `vitest.config.ts` 的 `projects` 数组中添加：

```json
"projects": ["pi-ask-user", ..., "pi-<name>"]
```

---

## 依赖管理

### peerDependencies vs dependencies

作为 pi 扩展包，**运行时依赖应尽量使用 peerDependencies**，让宿主（pi 本体）提供实例，避免多份副本造成单例冲突。

| 场景 | 使用 |
|------|------|
| pi 核心 API（agent、tui、ai） | `peerDependencies` |
| 外部工具库（如 `@ast-grep/cli`、`turndown`） | `dependencies` |
| 第三方 CLI（如 `@larksuite/cli`） | `optional` peerDependencies |

### 宿主提供包（host-provided packages）

宿主在加载扩展时会把下列包的 import 映射到自己的副本：

`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`（以及 `@mariozechner/*` 历史别名）、`typebox`、`@sinclair/typebox`。

因此这些包：

- **不得写入 `dependencies`**。宿主加载扩展时会扫描扩展包 manifest，命中即告警：

  ```
  Host-provided extension packages must be declared in peerDependencies with a "*" range,
  not dependencies: typebox. Installed copies can bypass the extension loader and create
  duplicate runtime modules.
  ```

  安装的副本还会与宿主版本不一致（例如宿主用 1.3.x，扩展带 1.1.x），造成重复运行时模块；
- 源码中 import 了就**必须声明在 `peerDependencies`**，由宿主提供实例；
- 其中 `typebox` 系按宿主约定使用 `*` 范围，并在 `devDependencies` 固定具体版本供本地开发/测试（例如 `"typebox": "^1.3.34"`）；
- pi 核心包（`@earendil-works/*`）的范围用最小宿主版本表达（当前 `>=1.5.0`），不要写成 `*`。

**只能 import 包根**（`typebox` 系例外，见下文）。宿主的模块注入表按模块 ID **精确匹配**：`@earendil-works/pi-ai` 只有包根与 `/compat`、`/models`、`/oauth`、`/providers/all` 这几个子路径，`@earendil-works/pi-coding-agent`、`/pi-agent-core`、`/pi-tui` 只映射包根。其它子路径（例如 `@earendil-works/pi-ai/utils/estimate`）在 `pi install` 装出来的扩展里解析不到——宿主自己的 `node_modules` 不在扩展的解析链上——启动就报 `Cannot find module`；而开发树里 `node_modules` 躺着真实包，**测试、类型检查都发现不了**。需要这类内部实现时，把它复制进本包源码。

一致性由 `npm run check:host-deps` 校验（CI 中执行）：

- 任何 workspace 的 `dependencies` 含宿主提供包 → 失败；
- 源码 import 了宿主提供包但未在 `peerDependencies` 声明 → 失败；
- 源码 import 了宿主提供包的未映射子路径（如 `@earendil-works/pi-ai/utils/estimate`）→ 失败；
- `typebox` 系的 `peerDependencies` 范围不是 `*` → 失败。

### 常用 peerDependencies

| 包 | 用途 |
|----|------|
| `@earendil-works/pi-coding-agent` | ExtensionAPI、registerTool / hooks 等核心 API |
| `@earendil-works/pi-tui` | TUI 组件（Container、Text、Markdown、Editor 等） |
| `@earendil-works/pi-ai` | AI 相关工具（Type.Unsafe 等） |
| `typebox` | 工具参数的 JSON Schema 定义（`"*"`，宿主提供；子路径 `typebox/compile`、`typebox/value` 同样由宿主映射） |

**统一使用 `typebox`**（当前 1.x 主线，与宿主自身依赖和官方示例一致）。`@sinclair/typebox`（0.x LTS）宿主也能识别，但它会被宿主映射到自己的 1.x 实现，而本地安装的是 0.34.x，形成「类型按 0.34 检查、运行时是 1.x」的 skew；新代码不要再用，存量代码建议迁移。

**工具参数校验口径**（自 pi 1.5.0 起）：工具参数由宿主的 `@earendil-works/pi-schema` 按 **JSON Schema** 校验，不论 schema 由谁构建——TypeBox 节点本身就是 JSON Schema，写法不受影响；受影响的是 TypeBox 里**超出 JSON Schema 的那部分特性**，逐项如下：

- `Type.Refine()` 的精细校验不会跑。
- `Type.Void()` 恒拒绝任何 JSON 参数。
- `Type.BigInt()`、`Type.Undefined()` 同样在 JSON Schema 之外，但行为随宿主**补丁**版本不同：**1.5.0 会拒绝**，**≥1.5.1 起按 TypeBox 规则转换**（`"42"` / `42` → `42n`，`null` → `undefined`）。
- 结论：工具参数不要用这三个类型（跨补丁版本行为不一致，且 JSON 无法往返 bigint / undefined），需要这类约束就在 `execute()` 里自己校验。
- codecs（`Type.Codec()`）不解码，`execute()` 拿到的是 JSON 原值。
- `Format.Set()` 注册的自定义格式不校验（标准格式以及 `url`、`json-pointer-uri-fragment` 仍校验）。
- 属性名按**名字**匹配，不当正则用；`additionalProperties` 只约束对象**未声明**的属性。
- 指向不存在目标的 `$ref` 只拒绝它所在位置的值。

校验前宿主会做**强制转换**，因此 `execute()` 里可能收到被「修好」的入参：数字串→数字、`"true"`→`true`、单值→单元素数组、optional 属性里 schema 不接受的 `null` 被丢弃。校验失败时模型看到的是 pi-schema 口径的错误消息，例如 `- path: missing`。需要上述这类约束（精细校验、BigInt、自定义格式等）就在 `execute()` 里自己查。宿主侧说明见 `@earendil-works/pi-coding-agent` 的 `docs/extensions.md#tool-parameter-schemas-and-typebox`；该节在 BigInt / Undefined 这一点上**落后于宿主自身 CHANGELOG**（1.5.1 的修复未回写），以 CHANGELOG 与实测为准。

### devDependencies

所有 Extension 包统一使用以下 devDependencies（**版本锁定见根 `package.json`**）：

- `@biomejs/biome`：格式化 + lint
- `typescript`：类型检查
- `@types/node`：Node 类型
- `vitest`：测试框架

Pure Skills 无需 devDependencies。

一致性由 `npm run check:dev-deps` 校验（CI 中执行）：Extension 包必须声明上述 4 项且版本串与根 `package.json` 完全一致，Pure Skills 不得声明。升级依赖时先改根 `package.json`，再同步各包版本串。

`package-lock.json` 与各 `package.json` 的一致性由 CI 的 `lockfile-sync` job 校验：`npm install --package-lock-only` 后 lockfile 不得出现 diff。本地修改依赖后务必执行 `npm install` 并提交 lockfile 变更。

### 为什么这些字段必须逐包重复

npm 的 `package.json` 没有 `extends`/继承机制。workspaces 发现、`npm ci` 构建依赖树、`npm publish` 的元数据与 provenance 都读磁盘上的实体文件，每个包的字段必须自足。以下重复属于 npm 固有成本：

- **`devDependencies`**：根是版本唯一来源，包内必须重复声明同样的 4 项且版本串逐字一致（`npm run check:dev-deps` 校验）。这些工具由根 hoist，包内 `node_modules/` 不承载它们。
- **`publishConfig.access`**：不能用根 `.npmrc` 的 `access=public` 顶替——npm 的 prefix 落在包目录，在包目录内运行 npm 时不读上级 `.npmrc`，只有从仓库根发布才读得到。
- **`license` / `type` / `repository` / `keywords`**：发布元数据，npm 逐包读取；`repository.directory` 本就每包不同，`license` 由 `npm run check:license` 保证与根一致。

两条不走的路：

- **生成器**（根模板 + 每包 manifest → 生成 `package.json`）：生成物仍必须提交（npm 读实体文件），省下的是十几行静态内容，换来的是「手改 package.json 无效」的间接层，净收益为负。
- **把标准 scripts 也收敛到根驱动**（从根执行 `vitest --project <npm 名>`、`tsc -p <dir>`、`biome check <dir>`）：技术上可行，但会让 `cd pi-<name> && npm test` 这类局部命令失效，DX 代价大于省下的行数。

---

## 发布流程

发布流程统一维护在 [docs/guides/release.md](release.md)，按 Extension / Pure Skills 分列。

---

## 附录 A：新建 Package 检查清单

逐项确认：

### 通用

- [ ] 目录名 `pi-<name>`，全小写、连字符分隔
- [ ] 根 `package.json` `workspaces` 已添加
- [ ] `.github/workflows/publish.yml` 已有对应 case
- [ ] `.github/workflows/test.yml` `paths-filter` 已添加对应 entry
- [ ] `README.md` + `README.zh.md` 已创建
- [ ] `.gitignore` 已创建（`node_modules/` + `*.tsbuildinfo`）
- [ ] `license` 与根 `package.json` 完全一致，包内无 `LICENSE` 副本
- [ ] `scripts` 已挂 `prepack` / `postpack` 许可钩子（见 [License：全仓单一来源](#license全仓单一来源)）
- [ ] `npm run check:license` 通过

### Extension

- [ ] `package.json` 字段完整（name、version、description、license、repository、type、files、scripts、pi、peerDependencies、devDependencies）
- [ ] `files` 至少包含 `"index.ts"` 和 `"src/"`
- [ ] `scripts` 包含 test / test:watch / typecheck / lint / format
- [ ] `npm run check:dev-deps` 与 `npm run check:host-deps` 通过（依赖声明符合规范）
- [ ] `npm run check:license` 通过（许可单一来源，见 [License：全仓单一来源](#license全仓单一来源)）
- [ ] `tsconfig.json` 继承 `../tsconfig.base.json`
- [ ] `vitest.config.ts` 已创建
- [ ] `index.ts` 导出 `export default function(pi: ExtensionAPI)`
- [ ] 源码放在 `src/`，测试放在 `tests/`
- [ ] 根 `vitest.config.ts` `projects` 已添加
- [ ] 如有 skills，`pi.skills` 已声明，`files` 已包含 `"skills/"`
- [ ] 如调用 `ctx.ui.*` 或对 `ctx.mode` / `ctx.hasUI` 分支：按 [UI 能力与跨模式降级](#ui-能力与跨模式降级) 的判据表选信号，并在 `README.md` / `README.zh.md` 各写一节 `## UI surface` / `## UI 能力`

### Pure Skills

- [ ] `package.json` 字段完整（name、version、description、license、repository、type、files、pi）
- [ ] `files` 至少包含 `"skills/"`
- [ ] `pi` 声明 `"skills": ["./skills"]`
- [ ] 无 `extensions` 字段
- [ ] skills 目录结构和 SKILL.md 正确

---

## 附录 B：重构 / 迁移指南

当需要批量调整 package 规范时，按以下清单逐项推进：

### 检查范围

- [ ] 所有 package 的 `package.json` 字段是否与本文档一致
- [ ] 所有 Extension package 的 `tsconfig.json` 是否统一继承 `../tsconfig.base.json`
- [ ] 所有 Extension package 的 `vitest.config.ts` 是否统一
- [ ] 所有 package 的 `.gitignore` 是否统一
- [ ] 所有 `README.md` / `README.zh.md` 是否存在且格式一致
- [ ] 根 `vitest.config.ts` 的 `projects` 是否涵盖所有 Extension package
- [ ] `.github/workflows/publish.yml` 是否涵盖所有 package
- [ ] `.github/workflows/test.yml` 的 `paths-filter` 是否涵盖所有 package
- [ ] `npm run typecheck && npm run lint && npm test` 全部通过
- [ ] `npm run check:dev-deps` 通过（devDependencies 与根 `package.json` 一致）
- [ ] `npm run check:host-deps` 通过（宿主提供包未写入 `dependencies`，import 的宿主提供包已在 `peerDependencies` 声明）
- [ ] `npm run check:license` 通过（全仓单一 `LICENSE`，各包 `license` 字段与根一致，包内无副本）

### 常见重构项

| 场景 | 操作 |
|------|------|
| 统一 tsconfig | 确认所有 Extension 包的 `tsconfig.json` 内容一致 |
| 统一 vitest.config | 确认所有 Extension 包的配置一致 |
| 批量升级依赖 | 修改根 `package.json` 的 devDependencies 版本，同步各 Extension 包版本串，`npm install` 全仓更新，`npm run check:dev-deps` 校验一致 |
| 新增 workspace | 根 `package.json` + CI + vitest 三处注册 |
| 移除 package | 反向操作，同步清理上述四处注册 |
| 修改 peerDependencies 版本下限 | 逐一修改各 package 的 `package.json` |
| 新增对宿主提供包的 import | 在 `peerDependencies` 声明（`typebox` 系用 `*`），`devDependencies` 固定具体版本，`npm run check:host-deps` 校验 |
| 统一 scripts | 确保所有 Extension 包有同样的 test / typecheck / lint / format 脚本名 |
