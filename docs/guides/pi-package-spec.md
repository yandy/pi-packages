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
    "@earendil-works/pi-coding-agent": ">=0.80.2"
    // 视需要追加：@earendil-works/pi-tui、@earendil-works/pi-ai、@sinclair/typebox
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
    "prepublishOnly": "npm run download-skills"
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

### 常用 peerDependencies

| 包 | 用途 |
|----|------|
| `@earendil-works/pi-coding-agent` | ExtensionAPI、registerTool / hooks 等核心 API |
| `@earendil-works/pi-tui` | TUI 组件（Container、Text、Markdown、Editor 等） |
| `@earendil-works/pi-ai` | AI 相关工具（Type.Unsafe 等） |
| `@sinclair/typebox` | 工具参数的 JSON Schema 定义 |

### devDependencies

所有 Extension 包统一使用以下 devDependencies（版本锁定见根 `package.json`）：

- `@biomejs/biome`：格式化 + lint
- `typescript`：类型检查
- `@types/node`：Node 类型
- `vitest`：测试框架

Pure Skills 无需 devDependencies。

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

### Extension

- [ ] `package.json` 字段完整（name、version、description、license、repository、type、files、scripts、pi、peerDependencies、devDependencies）
- [ ] `files` 至少包含 `"index.ts"` 和 `"src/"`
- [ ] `scripts` 包含 test / test:watch / typecheck / lint / format
- [ ] `tsconfig.json` 继承 `../tsconfig.base.json`
- [ ] `vitest.config.ts` 已创建
- [ ] `index.ts` 导出 `export default function(pi: ExtensionAPI)`
- [ ] 源码放在 `src/`，测试放在 `tests/`
- [ ] 根 `vitest.config.ts` `projects` 已添加
- [ ] 如有 skills，`pi.skills` 已声明，`files` 已包含 `"skills/"`

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

### 常见重构项

| 场景 | 操作 |
|------|------|
| 统一 tsconfig | 确认所有 Extension 包的 `tsconfig.json` 内容一致 |
| 统一 vitest.config | 确认所有 Extension 包的配置一致 |
| 批量升级依赖 | 修改根 `package.json` 的 devDependencies 版本，`npm install` 全仓更新 |
| 新增 workspace | 根 `package.json` + CI + vitest 三处注册 |
| 移除 package | 反向操作，同步清理上述四处注册 |
| 修改 peerDependencies 版本下限 | 逐一修改各 package 的 `package.json` |
| 统一 scripts | 确保所有 Extension 包有同样的 test / typecheck / lint / format 脚本名 |
