# 发布新版本

发布通过 GitHub Actions 自动完成，触发条件是创建 GitHub Release。

下文用 **`<pkg>` 表示包目录名**，即包名前缀一并算在内的完整目录名（`pi-notify`、`pi-ask-user`、`pi-coding-tools`）。tag、workspace 参数、提交信息、`gh release --title` 都用这同一个值，因此 tag 形如 `<pkg>-v<新版本号>`（例：`pi-notify-v0.2.0`）。

`publish.yml` 按 tag 前缀逐字匹配包目录（`pi-notify-v*` → `dir=pi-notify`），前缀写错不会报错，只会在 publish job 里因目录为空而失败。

## Extension Package（有 TS 代码）

```bash
# 在仓库根目录执行（下例的 <pkg> = pi-notify、<新版本号> = 0.2.0）：

# 1. 确保全部通过
npm run typecheck && npm run lint && npm test

# 2. 升级版本号并提交
npm version <新版本号> --workspace=<pkg> --no-git-tag-version
git add <pkg>/package.json package-lock.json
git commit -m "<pkg> v<新版本号>"
COMMIT=$(git rev-parse HEAD)

# 3. 推送
git push origin main

# 4. 创建 GitHub Release（gh 自动创建 tag，无需手动 git tag）
gh release create <pkg>-v<新版本号> --target $COMMIT \
  --title "<pkg> v<新版本号>" --notes ""
```

## Pure Skills Package（仅 skills 目录，无 TS 代码）

```bash
# 在仓库根目录执行：

# 1. 升级版本号并提交
npm version <新版本号> --workspace=<pkg> --no-git-tag-version
git add <pkg>/package.json package-lock.json
git commit -m "<pkg> v<新版本号>"
COMMIT=$(git rev-parse HEAD)

# 2. 推送
git push origin main

# 3. 创建 GitHub Release（触发发布）
gh release create <pkg>-v<新版本号> --target $COMMIT \
  --title "<pkg> v<新版本号>" --notes ""
```

创建 Release 后，`.github/workflows/publish.yml` 响应 `release: published` 事件，执行 `npm ci` + `npm publish --provenance --workspace=<pkg>`（OIDC 认证，无需本地 npm token）。如有 `prepublishOnly` 脚本会在 publish 前自动执行。新增包必须同时在上面的 tag 匹配分支里加一条 `case`。

发布到：`@yandy0725/<pkg>@<新版本号>`（public access）

## 注意事项

- `npm version --workspace` 在 monorepo 中不会自动 commit/tag（已用 `--no-git-tag-version`），需手动提交
- 必须同时 add `package.json` 和 `package-lock.json`
- `gh release create` 会自动创建对应名称的 git tag，**无需手动 `git tag`**
- `--target` 指定 tag 指向的 commit，必须是完整 SHA（缩写会报 `Release.target_commitish is invalid`），且确保 tag 落在版本升级的那个 commit 上
- `--workspace` 参数可用 `-w` 简写
- tag 必须以包目录名开头：`<pkg>-vX.Y.Z`。`vX.Y.Z`、`pi-<去掉前缀的名字>-vX.Y.Z`（例如把 `pi-notify` 写成 `pi-pi-notify`）都无法匹配，publish job 会因目录为空失败
- 发布时 `prepack` 钩子会把仓库根 `LICENSE` 复制进包目录（`postpack` 再删除），tarball 里的 `LICENSE` 因此总是与根保持一致；这个副本不要提交

## 发布后验收

publish job 绿不等于 registry 可查：npm 处理新版本期间版本文档返回 404、`dist-tags.latest` 仍是旧值（实测约 60–75 秒）。

```bash
curl -s -o /tmp/v.json -w '%{http_code}\n' "https://registry.npmjs.org/@yandy0725%2F<pkg>/<新版本号>"
node -p "JSON.parse(require('fs').readFileSync('/tmp/v.json','utf8')).dist.shasum"
curl -s "https://registry.npmjs.org/@yandy0725%2F<pkg>" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8'))['dist-tags'].latest"
```

版本文档返回 200 后，把 `dist.shasum` 与 publish 日志里 `npm notice shasum:` 逐字比对，并确认 `dist-tags.latest` 已翻到新版本。本机 npm 指向镜像源时以 `registry.npmjs.org` 为准。

## `pi-memory`

`pi-memory` 已迁往 [simple-memory](https://github.com/yandy/simple-memory)，其发布流程（含「core 必须先发」这条顺序约束）见该仓 `docs/guides/release.md`。
