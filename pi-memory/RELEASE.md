# 发布新版本

发布通过 GitHub Actions 自动完成，触发条件是创建 GitHub Release（Release tag 格式 `pi-memory-v*`）。

## 操作步骤

```bash
# 在仓库根目录执行：

# 1. 确保全部通过
npm run typecheck && npm run lint && npm test

# 2. 升级版本号并提交
npm version <新版本号> --workspace=pi-memory --no-git-tag-version
git add pi-memory/package.json package-lock.json
git commit -m "pi-memory v<新版本号>"
# 记录该 commit id
COMMIT=$(git rev-parse HEAD)

# 3. 推送
git push origin main

# 4. 创建 GitHub Release（gh 自动创建 tag，无需手动 git tag）
gh release create pi-memory-v<新版本号> --target $COMMIT \
  --title "pi-memory v<新版本号>" --notes ""
```

创建 Release 后，`.github/workflows/publish.yml` 响应 `release: published` 事件，执行 `npm ci` + `npm publish --provenance --workspace=pi-memory`（OIDC 认证，无需本地 npm token）。

发布到：`@yandy0725/pi-memory@X.Y.Z`（public access）

## 注意事项

- `npm version --workspace` 在 monorepo 中不会自动 commit/tag（已用 `--no-git-tag-version`），需手动提交
- `gh release create` 会自动创建对应名称的 git tag，**无需手动 `git tag`**
- `--target` 指定 tag 指向的 commit，确保 tag 落在版本升级的那个 commit 上
- `--workspace` 参数可用 `-w` 简写
- tag 格式必须是 `pi-memory-vX.Y.Z`，不能是 `vX.Y.Z`
