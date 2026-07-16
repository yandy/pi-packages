# npm Workspaces Monorepo 改造设计

**日期:** 2026-06-22  
**状态:** 已批准

## 背景

`pi-packages` 包含 3 个 npm 包（`pi-coding-tools`、`pi-container-sandbox`、`pi-web-tools`），当前没有启用任何 monorepo 工具。每个包各自维护独立的 `node_modules/`、`package-lock.json`、以及内容完全相同的 `tsconfig.json` 和 `vitest.config.ts`。日常开发必须 `cd` 到对应目录操作。

## 目标

- 根目录一条命令跑所有包的 test/lint/typecheck/format
- 统一管理共享依赖，消除重复安装，利用 npm workspaces 共享 `node_modules`
- 共享 tsconfig、vitest、biome 配置，减少维护负担
- 最小化 CI 改动，不破坏现有发布流程和 path-filter 增量检测

## 方案：npm Workspaces + 配置共享

### 包管理器

使用 **npm workspaces**（已在用 npm，改动最小）。

### 目录结构变化

```
pi-packages/
├── package.json          ← 新增：根 package.json
├── tsconfig.base.json    ← 新增：共享 TS 配置
├── vitest.workspace.ts   ← 新增：vitest workspace 配置
├── biome.json            ← 上移：共享 biome 配置
├── .gitignore            ← 保留（已覆盖 node_modules）
├── pi-coding-tools/
│   ├── package.json
│   ├── tsconfig.json     ← 改为 extends ../tsconfig.base.json
│   ├── vitest.config.ts  ← 删除
│   ├── biome.json        ← 删除
│   └── ...
├── pi-container-sandbox/
│   ├── package.json
│   ├── tsconfig.json     ← 改为 extends ../tsconfig.base.json
│   ├── vitest.config.ts  ← 删除
│   ├── biome.json        ← 删除
│   └── ...
└── pi-web-tools/
    ├── package.json
    ├── tsconfig.json     ← 改为 extends ../tsconfig.base.json
    ├── vitest.config.ts  ← 删除
    ├── biome.json        ← 删除
    └── ...
```

根执行 `npm ci` 后，`node_modules/` 提升到根目录，所有 package 共享。

### 1. 根 package.json

```jsonc
{
  "private": true,
  "workspaces": [
    "pi-coding-tools",
    "pi-container-sandbox",
    "pi-web-tools"
  ],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "format": "npm run format --workspaces --if-present",
    "check": "npm run check --workspaces --if-present"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.0",
    "typescript": "~5.7.0",
    "@types/node": "^22.0.0",
    "vitest": "^3.0.0"
  }
}
```

- `"private": true` 防止根目录被意外 publish
- devDependencies 提升到根，各子包不再重复声明这些依赖
- `--if-present` 确保某个包没有某个脚本时不会报错

### 2. 共享 tsconfig

根 `tsconfig.base.json`：

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "lib": ["ES2022"]
  }
}
```

子包 `tsconfig.json` 简化为：

```jsonc
{
  "extends": "../tsconfig.base.json",
  "include": ["index.ts", "src/**/*.ts", "tests/**/*.ts"]
}
```

### 3. 共享 vitest

使用 vitest workspace 模式。根 `vitest.workspace.ts`：

```ts
export default ["pi-coding-tools", "pi-container-sandbox", "pi-web-tools"];
```

子包的 `vitest.config.ts` 删除。根目录运行 `npx vitest` 即可跑全部。

### 4. 共享 biome

根 `biome.json`（3 个包当前配置完全一致，直接使用现有内容）：

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.0/schema.json",
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "indentWidth": 1,
    "lineWidth": 120,
    "lineEnding": "lf"
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "trailingCommas": "all",
      "semicolons": "always",
      "arrowParentheses": "always"
    }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "preset": "recommended",
      "style": { "noUnusedTemplateLiteral": "off" },
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error"
      },
      "suspicious": {
        "noExplicitAny": "warn",
        "noEmptyBlockStatements": "off"
      }
    }
  },
  "files": { "includes": ["**/*.ts", "**/*.json"], "ignoreUnknown": true }
}
```

子包的 `biome.json` 删除。

### 5. CI 适配

#### test.yml

合并为单 job，根目录执行所有操作：

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      packages: ${{ steps.filter.outputs.changes }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            pi-container-sandbox:
              - "pi-container-sandbox/**"
            pi-web-tools:
              - "pi-web-tools/**"
            pi-coding-tools:
              - "pi-coding-tools/**"

  test:
    needs: changes
    if: needs.changes.outputs.packages != '[]' && needs.changes.outputs.packages != ''
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: npm
      - run: npm ci
      - run: npm run typecheck --workspaces --if-present
      - run: npm run check --workspaces --if-present
      - run: npm test --workspaces --if-present
```

关键变化：
- `npm ci` 只在根目录执行一次（workspaces 自动安装所有子包依赖）
- `--workspaces` 遍历所有子包执行脚本
- `cache-dependency-path` 不再需要指定每个包，setup-node 自动找到根 `package-lock.json`

#### publish.yml

`npm ci` 移到根目录，发布用 `--workspace`：

```yaml
name: Publish to npm

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org

      - name: Determine package directory
        id: info
        run: |
          TAG="${{ github.event.release.tag_name }}"
          case "$TAG" in
            pi-container-sandbox-v*)
              echo "dir=pi-container-sandbox" >> "$GITHUB_OUTPUT"
              ;;
            pi-web-tools-v*)
              echo "dir=pi-web-tools" >> "$GITHUB_OUTPUT"
              ;;
            pi-coding-tools-v*)
              echo "dir=pi-coding-tools" >> "$GITHUB_OUTPUT"
              ;;
          esac

      - run: npm ci

      - run: npm publish --provenance --workspace=${{ steps.info.outputs.dir }}
```

不改动：
- `paths-filter` 增量检测逻辑
- tag 匹配逻辑（`pi-container-sandbox-v*` 等）

### 6. 各子包 package.json 依赖调整

将以下 devDependencies 从各子包移除（已提升到根）：
- `@biomejs/biome`
- `typescript`
- `vitest`
- `@types/node`

每个子包的 `scripts` 保持不变。

### 7. `.gitignore`

现有 `.gitignore` 已包含 `node_modules/`，无需改动。

### 8. 文档适配

#### 8.1 根 README.md

当前内容仅为 "Monorepo for @yandy pi packages Resources"。扩展为：

```markdown
# pi-packages

Monorepo for @yandy pi packages. Uses npm workspaces.

## Packages

| Package | Description | npm |
|---|---|---|
| [pi-coding-tools](./pi-coding-tools) | apply_patch tool + ls/find/grep built-in tools | `@yandy0725/pi-coding-tools` |
| [pi-container-sandbox](./pi-container-sandbox) | Docker sandbox extension | `@yandy0725/pi-container-sandbox` |
| [pi-web-tools](./pi-web-tools) | web_search + web_fetch tools | `@yandy0725/pi-web-tools` |

## Development

```bash
npm ci                    # Install all dependencies (root + all workspaces)
npm run typecheck         # Type-check all packages
npm run check             # Lint + format check all packages
npm run format            # Format all packages
npm test                  # Run all tests
```

## Release

See `RELEASE.md` in each package directory.
```

#### 8.2 各子包 README.md Development 节

当前各子包 README 的 "Development" 节列出了 `npm install`、`npm test` 等命令。需更新为：

**pi-container-sandbox/README.md：**
```markdown
## Development

```bash
# From repo root:
npm ci                    # Install all dependencies
npm run typecheck         # Type-check all packages
npm test                  # Run all tests

# Package-specific:
npm run build-image --workspace=pi-container-sandbox
pi -e ./index.ts          # Run the extension locally (from this dir)
bash tests/e2e.sh         # Run E2E tests (requires Docker + pi CLI)
```
```

**pi-web-tools/README.md：**
```markdown
## Development

```bash
# From repo root:
npm ci                    # Install all dependencies
npm run typecheck         # Type-check all packages
npm run check             # Lint + format check
npm test                  # Run all tests

# Package-specific:
pi -e ./index.ts          # Run the extension locally (from this dir)
```
```

#### 8.3 各子包 RELEASE.md

关键变化：
- 不再需要 `cd` 进子包目录
- `package-lock.json` 路径改为根目录
- 发布前验证可引用根命令

**以 pi-coding-tools 为例（3 个包模式相同）：**

```markdown
# 发布新版本

发布通过 GitHub Actions 自动完成，触发条件是推送 `pi-coding-tools-v*` 格式的 git tag。

## 操作步骤

```bash
# 在仓库根目录执行：

# 1. 确保全部通过
npm run typecheck && npm run check && npm test

# 2. 升级版本号并打 tag
npm version <新版本号> --workspace=pi-coding-tools --no-git-tag-version
git add pi-coding-tools/package.json package-lock.json
git commit -m "pi-coding-tools v<新版本号>"
git tag pi-coding-tools-v<新版本号>

# 3. 推送
git push origin main --tags

# 4. 创建 GitHub Release（触发发布）
gh release create pi-coding-tools-v<新版本号> --title "pi-coding-tools v<新版本号>" --notes ""
```

创建 Release 后，`.github/workflows/publish.yml` 响应 `release: published` 事件，执行 `npm ci` + `npm publish --provenance --workspace=pi-coding-tools`（OIDC 认证，无需本地 npm token）。

发布到：`@yandy0725/pi-coding-tools@X.Y.Z`（public access）

## 注意事项

- `npm version --workspace` 在 monorepo 中不会自动 commit/tag（已用 `--no-git-tag-version`），需手动操作
- `--workspace` 参数可用 `-w` 简写
- tag 格式必须是 `pi-coding-tools-vX.Y.Z`，不能是 `vX.Y.Z`
```

其余两个包的 RELEASE.md 按相同模式更新（替换包名和 workspace 参数）。

## 不变的部分

- 各子包的 `package.json` 中除 devDependencies 外的所有字段（name、version、dependencies、peerDependencies、pi 等）
- 发布流程 tag 匹配逻辑
- path-filter 增量检测
- 各子包的源码、测试文件
- 各子包的 README 主体内容（仅 Development 节更新）

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| Workspaces 提升导致幽灵依赖 | 现有包无跨包依赖，影响极小；已提升的 devDependencies 只在开发期使用 |
| `install` 脚本行为变化 | 子包无 postinstall/preinstall 钩子 |
| 根 package-lock.json 合并时冲突 | 改造是一次性操作，后续保持单一 lockfile |
| RELEASE.md 中 lockfile 路径过期 | 已在新 RELEASE.md 中改为根目录 `package-lock.json` |
| 子包 node_modules 残留 | `npm ci` 前清理各子包 `node_modules/`，然后忽略即可 |
