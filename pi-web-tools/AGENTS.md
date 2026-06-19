# pi-web-tools Agent 指南

## 发布新版本

发布通过 GitHub Actions 自动完成，触发条件是推送特定格式的 git tag。

### 操作步骤

```bash
cd pi-web-tools

# 1. 升级版本号并打 tag（tag 格式: pi-web-tools-vX.Y.Z）
npm version <新版本号> --no-git-tag-version   # 或手动改 package.json
git add package.json package-lock.json
git commit -m "<新版本号>"
git tag pi-web-tools-v<新版本号>

# 2. 推送 main 分支和 tag
git push origin main --tags
```

推送到 GitHub 后，`.github/workflows/publish.yml` 自动匹配 `pi-web-tools-v*` tag，执行：

```
npm install  (在 pi-web-tools/ 目录)
npm publish --provenance  (通过 OIDC 认证，无需本地 npm token)
```

发布到：`@yandy0725/pi-web-tools@X.Y.Z`（public access）

### 注意事项

- `npm version` 在 monorepo 子目录下可能不会自动 commit/tag，建议用 `--no-git-tag-version` 然后手动操作
- 不要创建 `vX.Y.Z` 格式的 tag，必须是 `pi-web-tools-vX.Y.Z`
- 发布前确保 `npm run typecheck`、`npm run lint`、`npm run test` 全部通过
