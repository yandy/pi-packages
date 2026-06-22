# npm Workspaces Monorepo 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 pi-packages 从各自独立的 npm 包改造为 npm workspaces monorepo，在根目录即可统一操作所有包。

**Architecture:** 新增根 package.json 启用 npm workspaces，上移共享配置（tsconfig、vitest、biome），提升公共 devDependencies，适配 CI 和文档。

**Tech Stack:** npm workspaces, TypeScript ~5.7, vitest ^3.0, biome ^2.5

## Global Constraints

- 使用 npm workspaces（不用 pnpm/yarn）
- 各子包 package.json 的 name、version、dependencies、peerDependencies、pi 等字段不做任何修改（仅移除共享 devDeps）
- 包之间无相互依赖
- CI 保留 path-filter 增量检测逻辑
- 发布 tag 匹配逻辑不变（`pi-xxx-v*` 格式）

---

### Task 1: 创建根配置文件，上移共享配置

**Files:**
- Create: `package.json` (root)
- Create: `tsconfig.base.json` (root)
- Create: `vitest.workspace.ts` (root)
- Create: `biome.json` (root) — copy from any subpackage

**Interfaces:**
- Produces: `package.json:workspaces[3]` — workspace 列表供 npm 识别子包
- Produces: `tsconfig.base.json:compilerOptions` — 供子包 tsconfig extends
- Produces: `vitest.workspace.ts:default export` — 供 vitest 发现所有 workspace
- Produces: `biome.json` — 供 biome CLI 从根目录运行

- [ ] **Step 1: Create root `package.json`**

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

- [ ] **Step 2: Create root `tsconfig.base.json`**

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

- [ ] **Step 3: Create root `vitest.workspace.ts`**

```ts
export default ["pi-coding-tools", "pi-container-sandbox", "pi-web-tools"];
```

- [ ] **Step 4: Copy `biome.json` to root**

Copy `pi-coding-tools/biome.json` to root `biome.json`:

```bash
cp pi-coding-tools/biome.json biome.json
```

- [ ] **Step 5: Verify files exist**

```bash
ls package.json tsconfig.base.json vitest.workspace.ts biome.json
```

Expected: all 4 files listed.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json vitest.workspace.ts biome.json
git commit -m "feat: add root package.json, tsconfig, vitest workspace, and biome config"
```

---

### Task 2: 适配各子包配置

**Files:**
- Modify: `pi-coding-tools/tsconfig.json`
- Modify: `pi-container-sandbox/tsconfig.json`
- Modify: `pi-web-tools/tsconfig.json`
- Modify: `pi-coding-tools/package.json` — remove shared devDeps
- Modify: `pi-container-sandbox/package.json` — remove shared devDeps
- Modify: `pi-web-tools/package.json` — remove shared devDeps
- Delete: `pi-coding-tools/vitest.config.ts`
- Delete: `pi-container-sandbox/vitest.config.ts`
- Delete: `pi-web-tools/vitest.config.ts`
- Delete: `pi-coding-tools/biome.json`
- Delete: `pi-container-sandbox/biome.json`
- Delete: `pi-web-tools/biome.json`

**Interfaces:**
- Consumes: `tsconfig.base.json:compilerOptions` (from Task 1)

- [ ] **Step 1: Update `pi-coding-tools/tsconfig.json`**

Replace entire content with:

```jsonc
{
	"extends": "../tsconfig.base.json",
	"include": ["index.ts", "src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 2: Update `pi-container-sandbox/tsconfig.json`**

Replace entire content with:

```jsonc
{
	"extends": "../tsconfig.base.json",
	"include": ["index.ts", "src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Update `pi-web-tools/tsconfig.json`**

Replace entire content with:

```jsonc
{
	"extends": "../tsconfig.base.json",
	"include": ["index.ts", "src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 4: Remove shared devDeps from `pi-coding-tools/package.json`**

Remove these entries from `devDependencies`:
- `"@biomejs/biome": "^2.5.0"`
- `"@types/node": "^22.0.0"`
- `"typescript": "~5.7.0"`
- `"vitest": "^3.0.0"`

After removal, `pi-coding-tools/package.json` devDependencies should be empty (`{}` or no `devDependencies` key).

- [ ] **Step 5: Remove shared devDeps from `pi-container-sandbox/package.json`**

Remove these entries from `devDependencies`:
- `"@biomejs/biome": "^2.5.0"`
- `"@types/node": "^22.0.0"`
- `"typescript": "~5.7.0"`
- `"vitest": "^3.0.0"`

After removal, remaining devDependencies: `"@types/dockerode": "^4.0.1"`.

- [ ] **Step 6: Remove shared devDeps from `pi-web-tools/package.json`**

Remove these entries from `devDependencies`:
- `"@biomejs/biome": "^2.5.0"`
- `"@types/node": "^22.0.0"`
- `"typescript": "~5.7.0"`
- `"vitest": "^3.0.0"`

After removal, remaining devDependencies: `"@earendil-works/pi-tui": "^0.79.9"`, `"typebox": "^1.1.38"`.

- [ ] **Step 7: Delete redundant per-package files**

```bash
rm pi-coding-tools/vitest.config.ts
rm pi-container-sandbox/vitest.config.ts
rm pi-web-tools/vitest.config.ts
rm pi-coding-tools/biome.json
rm pi-container-sandbox/biome.json
rm pi-web-tools/biome.json
```

- [ ] **Step 8: Clean old install artifacts**

```bash
rm -rf pi-coding-tools/node_modules pi-coding-tools/package-lock.json
rm -rf pi-container-sandbox/node_modules pi-container-sandbox/package-lock.json
rm -rf pi-web-tools/node_modules pi-web-tools/package-lock.json
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: adapt subpackages to npm workspaces — extend root tsconfig, hoist shared devDeps, remove redundant configs"
```

---

### Task 3: 安装依赖并验证所有脚本通过

**Files:**
- Create: `package-lock.json` (root, generated by npm)
- Create: `node_modules/` (root, generated by npm)

**Interfaces:**
- Consumes: root `package.json:workspaces`, `package.json:scripts` (from Task 1)
- Consumes: subpackage `package.json:scripts` (untouched, just verified they work)

- [ ] **Step 1: Install all dependencies from root**

```bash
npm install
```

Expected: no errors. Root `node_modules/` created with shared deps (`typescript`, `vitest`, `@biomejs/biome`, `@types/node`) and all package-specific deps visible. Root `package-lock.json` created.

- [ ] **Step 2: Run typecheck on all packages**

```bash
npm run typecheck
```

Expected: all packages pass, no type errors.

- [ ] **Step 3: Run biome check on all packages**

```bash
npm run check
```

Expected: all packages pass lint + format check.

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all vitest suites pass.

- [ ] **Step 5: Commit**

```bash
git add package-lock.json
git commit -m "chore: add root lockfile after workspace install"
```

---

### Task 4: 更新 CI Workflows

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/publish.yml`

- [ ] **Step 1: Update `.github/workflows/test.yml`**

Replace entire file content with:

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

- [ ] **Step 2: Update `.github/workflows/publish.yml`**

Replace entire file content with:

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

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml .github/workflows/publish.yml
git commit -m "ci: adapt workflows to npm workspaces — single npm ci at root, --workspaces for scripts"
```

---

### Task 5: 更新文档

**Files:**
- Modify: `README.md` (root)
- Modify: `pi-container-sandbox/README.md:Development section`
- Modify: `pi-web-tools/README.md:Development section`
- Modify: `pi-coding-tools/RELEASE.md`
- Modify: `pi-container-sandbox/RELEASE.md`
- Modify: `pi-web-tools/RELEASE.md`

- [ ] **Step 1: Update root `README.md`**

Replace entire file content with:

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

- [ ] **Step 2: Update `pi-container-sandbox/README.md` Development section**

Replace oldText:

    ## Development

    ```bash
    npm install              # install dependencies
    npm run typecheck        # tsc --noEmit
    npm test                 # vitest run
    npm run build-image      # build the sandbox image
    pi -e ./index.ts         # run the extension locally
    bash tests/e2e.sh        # run E2E tests (requires Docker + pi CLI)
    ```

With newText:

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

- [ ] **Step 3: Update `pi-web-tools/README.md` Development section**

Replace oldText:

    ## Development

    ```bash
    npm install              # Install dependencies
    npm run typecheck        # tsc --noEmit
    npm run lint             # biome lint
    npm test                 # vitest run
    ```

With newText:

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

- [ ] **Step 4: Update `pi-coding-tools/RELEASE.md`**

Replace entire file content with:

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

- [ ] **Step 5: Update `pi-container-sandbox/RELEASE.md`**

Replace entire file content with:

```markdown
# 发布新版本

发布通过 GitHub Actions 自动完成，触发条件是推送 `pi-container-sandbox-v*` 格式的 git tag。

## 操作步骤

```bash
# 在仓库根目录执行：

# 1. 确保全部通过
npm run typecheck && npm run check && npm test

# 2. 升级版本号并打 tag
npm version <新版本号> --workspace=pi-container-sandbox --no-git-tag-version
git add pi-container-sandbox/package.json package-lock.json
git commit -m "pi-container-sandbox v<新版本号>"
git tag pi-container-sandbox-v<新版本号>

# 3. 推送
git push origin main --tags

# 4. 创建 GitHub Release（触发发布）
gh release create pi-container-sandbox-v<新版本号> --title "pi-container-sandbox v<新版本号>" --notes ""
```

创建 Release 后，`.github/workflows/publish.yml` 响应 `release: published` 事件，执行 `npm ci` + `npm publish --provenance --workspace=pi-container-sandbox`（OIDC 认证，无需本地 npm token）。

发布到：`@yandy0725/pi-container-sandbox@X.Y.Z`（public access）

## 注意事项

- `npm version --workspace` 在 monorepo 中不会自动 commit/tag（已用 `--no-git-tag-version`），需手动操作
- `--workspace` 参数可用 `-w` 简写
- tag 格式必须是 `pi-container-sandbox-vX.Y.Z`，不能是 `vX.Y.Z`
```

- [ ] **Step 6: Update `pi-web-tools/RELEASE.md`**

Replace entire file content with:

```markdown
# 发布新版本

发布通过 GitHub Actions 自动完成，触发条件是推送 `pi-web-tools-v*` 格式的 git tag。

## 操作步骤

```bash
# 在仓库根目录执行：

# 1. 确保全部通过
npm run typecheck && npm run check && npm test

# 2. 升级版本号并打 tag
npm version <新版本号> --workspace=pi-web-tools --no-git-tag-version
git add pi-web-tools/package.json package-lock.json
git commit -m "pi-web-tools v<新版本号>"
git tag pi-web-tools-v<新版本号>

# 3. 推送
git push origin main --tags

# 4. 创建 GitHub Release（触发发布）
gh release create pi-web-tools-v<新版本号> --title "pi-web-tools v<新版本号>" --notes ""
```

创建 Release 后，`.github/workflows/publish.yml` 响应 `release: published` 事件，执行 `npm ci` + `npm publish --provenance --workspace=pi-web-tools`（OIDC 认证，无需本地 npm token）。

发布到：`@yandy0725/pi-web-tools@X.Y.Z`（public access）

## 注意事项

- `npm version --workspace` 在 monorepo 中不会自动 commit/tag（已用 `--no-git-tag-version`），需手动操作
- `--workspace` 参数可用 `-w` 简写
- tag 格式必须是 `pi-web-tools-vX.Y.Z`，不能是 `vX.Y.Z`
```

- [ ] **Step 7: Commit**

```bash
git add README.md pi-container-sandbox/README.md pi-web-tools/README.md pi-coding-tools/RELEASE.md pi-container-sandbox/RELEASE.md pi-web-tools/RELEASE.md
git commit -m "docs: update README and RELEASE for npm workspaces monorepo workflow"
```

---

## Execution Order

Tasks must be executed in order (1 → 2 → 3 → 4 → 5), as each builds on the previous.

Tasks 4 and 5 are independent of each other and could run in parallel after Task 3 completes.
