# Design: Publish 从 tag 触发改为 GitHub Release 触发

**Date:** 2026-06-19
**Status:** approved

## Summary

将 npm 发布工作流从 `push: tags` 触发改为 `release: published` 触发。本地版本 bump 流程不变，发布通过 GitHub Release（可用 `gh` CLI 创建）触发。

## Scope

### Files to modify

| File | Change |
|------|--------|
| `.github/workflows/publish.yml` | 触发条件从 `on: push: tags:` 改为 `on: release: types: [published]`，tag 来源从 `github.ref_name` 改为 `github.event.release.tag_name` |
| `pi-web-tools/RELEASE.md` | 更新发布流程说明 |
| `pi-container-sandbox/RELEASE.md` | 更新发布流程说明 |

### 新发布流程

```bash
# 1. 本地 bump 版本（不变）
cd <package-dir>
npm version <版本号> --no-git-tag-version
git add package.json package-lock.json
git commit -m "<版本号>"
git tag <package>-v<版本号>
git push origin main --tags

# 2. 通过 gh CLI 创建 Release（新增，触发发布）
gh release create <package>-v<版本号> --title "<package> v<版本号>" --notes ""

# 或者通过 GitHub Web UI 手动创建
```

`release: published` 触发 publish 工作流后：
1. 读取 `github.event.release.tag_name`
2. 根据 tag 前缀确定包目录
3. `npm install` + `npm publish --provenance`

### 不涉及变更

- 本地版本 bump 流程不变
- `test.yml` 不变
- `package.json` 不变
