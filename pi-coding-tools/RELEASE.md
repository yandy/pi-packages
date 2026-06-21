# 发布新版本

发布通过 GitHub Actions 自动完成，触发条件是推送 `pi-coding-tools-v*` 格式的 git tag。

## 操作步骤

```bash
cd pi-coding-tools

# 1. 升级版本号并打 tag
npm version <新版本号> --no-git-tag-version
git add package.json package-lock.json
git commit -m "<新版本号>"
git tag pi-coding-tools-v<新版本号>

# 2. 推送
git push origin main --tags

# 3. 创建 GitHub Release（触发发布）
gh release create pi-coding-tools-v<新版本号> --title "pi-coding-tools v<新版本号>" --notes ""
```

创建 Release 后，`.github/workflows/publish.yml` 响应 `release: published` 事件，执行 `npm install` + `npm publish --provenance`（OIDC 认证，无需本地 npm token）。

发布到：`@yandy0725/pi-coding-tools@X.Y.Z`（public access）

## 注意事项

- `npm version` 在 monorepo 子目录下不会自动 commit/tag，需手动操作
- tag 格式必须是 `pi-coding-tools-vX.Y.Z`，不能是 `vX.Y.Z`
- 发布前确保 `npm run typecheck`、`npm run lint`、`npm run test` 全部通过
