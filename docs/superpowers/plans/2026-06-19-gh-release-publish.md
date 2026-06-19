# GitHub Release-based Publish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change npm publish trigger from `push: tags` to `release: published`, and update release documentation accordingly.

**Architecture:** Modify publish.yml workflow trigger and tag reference, update RELEASE.md for both packages.

**Tech Stack:** GitHub Actions YAML, Markdown

---

### Task 1: Modify publish.yml — trigger and tag reference

**Files:**
- Modify: `.github/workflows/publish.yml`

- [ ] **Step 1: Read current file**

Read `.github/workflows/publish.yml` to confirm content matches expected state.

- [ ] **Step 2: Change trigger from push:tags to release:published**

Replace:
```yaml
on:
  push:
    tags:
      - 'pi-container-sandbox-v*'
      - 'pi-web-tools-v*'
```
With:
```yaml
on:
  release:
    types: [published]
```

- [ ] **Step 3: Change tag source from github.ref_name to release tag**

In "Determine package directory" step, replace:
```yaml
      - name: Determine package directory
        id: info
        run: |
          TAG="${{ github.ref_name }}"
          case "$TAG" in
```
With:
```yaml
      - name: Determine package directory
        id: info
        run: |
          TAG="${{ github.event.release.tag_name }}"
          case "$TAG" in
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: trigger publish on GitHub Release instead of tag push"
```

---

### Task 2: Update RELEASE.md — pi-web-tools

**Files:**
- Modify: `pi-web-tools/RELEASE.md`

- [ ] **Step 1: Update publish steps to include gh release create**

Replace the "操作步骤" section:
```markdown
## 操作步骤

```bash
cd pi-web-tools

# 1. 升级版本号并打 tag
npm version <新版本号> --no-git-tag-version
git add package.json package-lock.json
git commit -m "<新版本号>"
git tag pi-web-tools-v<新版本号>

# 2. 推送
git push origin main --tags
```

推送到 GitHub 后，`.github/workflows/publish.yml` 自动匹配 `pi-web-tools-v*` tag，执行 `npm install` + `npm publish --provenance`（OIDC 认证，无需本地 npm token）。
```
With:
```markdown
## 操作步骤

```bash
cd pi-web-tools

# 1. 升级版本号并打 tag
npm version <新版本号> --no-git-tag-version
git add package.json package-lock.json
git commit -m "<新版本号>"
git tag pi-web-tools-v<新版本号>

# 2. 推送
git push origin main --tags

# 3. 创建 GitHub Release（触发发布）
gh release create pi-web-tools-v<新版本号> --title "pi-web-tools v<新版本号>" --notes ""
```

创建 Release 后，`.github/workflows/publish.yml` 响应 `release: published` 事件，执行 `npm install` + `npm publish --provenance`（OIDC 认证，无需本地 npm token）。
```

- [ ] **Step 2: Commit**

```bash
git add pi-web-tools/RELEASE.md
git commit -m "docs: update pi-web-tools RELEASE.md for GitHub Release workflow"
```

---

### Task 3: Update RELEASE.md — pi-container-sandbox

**Files:**
- Modify: `pi-container-sandbox/RELEASE.md`

- [ ] **Step 1: Update publish steps to include gh release create**

Replace the "操作步骤" section:
```markdown
## 操作步骤

```bash
cd pi-container-sandbox

# 1. 升级版本号并打 tag
npm version <新版本号> --no-git-tag-version
git add package.json package-lock.json
git commit -m "<新版本号>"
git tag pi-container-sandbox-v<新版本号>

# 2. 推送
git push origin main --tags
```

推送到 GitHub 后，`.github/workflows/publish.yml` 自动匹配 `pi-container-sandbox-v*` tag，执行 `npm install` + `npm publish --provenance`（OIDC 认证，无需本地 npm token）。
```
With:
```markdown
## 操作步骤

```bash
cd pi-container-sandbox

# 1. 升级版本号并打 tag
npm version <新版本号> --no-git-tag-version
git add package.json package-lock.json
git commit -m "<新版本号>"
git tag pi-container-sandbox-v<新版本号>

# 2. 推送
git push origin main --tags

# 3. 创建 GitHub Release（触发发布）
gh release create pi-container-sandbox-v<新版本号> --title "pi-container-sandbox v<新版本号>" --notes ""
```

创建 Release 后，`.github/workflows/publish.yml` 响应 `release: published` 事件，执行 `npm install` + `npm publish --provenance`（OIDC 认证，无需本地 npm token）。
```

- [ ] **Step 2: Commit**

```bash
git add pi-container-sandbox/RELEASE.md
git commit -m "docs: update pi-container-sandbox RELEASE.md for GitHub Release workflow"
```

---

### Task 4: Verify

- [ ] **Step 1: Verify no syntax errors in publish.yml**

```bash
# Use yamllint or just verify it's valid YAML
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/publish.yml'))" 2>&1
```
Expected: no errors.

- [ ] **Step 2: Push all commits**

```bash
git push origin main
```
