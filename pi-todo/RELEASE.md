# 发布新版本

发布通过 GitHub Actions 自动完成，触发条件是推送 `pi-todo-v*` 格式的 git tag。

## 操作步骤

```bash
# 在仓库根目录执行：

# 1. 确保全部通过
npm run typecheck && npm run check && npm test

# 2. 升级版本号并打 tag
npm version <新版本号> --workspace=pi-todo --no-git-tag-version
git add pi-todo/package.json package-lock.json
git commit -m "pi-todo v<新版本号>"
git tag pi-todo-v<新版本号>

# 3. 推送
git push origin main --tags

# 4. 创建 GitHub Release（触发发布）
gh release create pi-todo-v<新版本号> --title "pi-todo v<新版本号>" --notes ""
```

创建 Release 后，`.github/workflows/publish.yml` 响应 `release: published` 事件，执行 `npm ci` + `npm publish --provenance --workspace=pi-todo`（OIDC 认证，无需本地 npm token）。

发布到：`@yandy0725/pi-todo@X.Y.Z`（public access）

## 注意事项

- `npm version --workspace` 在 monorepo 中不会自动 commit/tag（已用 `--no-git-tag-version`），需手动操作
- `--workspace` 参数可用 `-w` 简写
- tag 格式必须是 `pi-todo-vX.Y.Z`，不能是 `vX.Y.Z`
