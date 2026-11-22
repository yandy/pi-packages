# pi-packages

@yandy pi 扩展包的 Monorepo。使用 npm workspaces 管理。

## 包列表

| 包 | 描述 | npm |
|---|---|---|
| [pi-ask-user](./pi-ask-user/README.zh.md) | 交互式 ask_user 工具，支持可搜索分栏 UI、多选和自由文本 | `@yandy0725/pi-ask-user` |
| [pi-coding-tools](./pi-coding-tools/README.zh.md) | AST/LSP 代码智能工具（ast_grep_search/ast_grep_replace/lsp_symbols/lsp_hover/lsp_navigate） | `@yandy0725/pi-coding-tools` |
| [pi-sandbox](./pi-sandbox/README.zh.md) | 进程级沙箱扩展（bwrap/landlock/seatbelt/windows-acl）：工作目录可写、其余宿主文件可读，fail-closed | `@yandy0725/pi-sandbox` |
| [pi-subagents](./pi-subagents/README.zh.md) | 进程内子代理核心，支持后台执行和类型化 API | `@yandy0725/pi-subagents` |
| [pi-todo](./pi-todo/README.zh.md) | 极简 todo 工具，带编辑器嵌入式小组件 | `@yandy0725/pi-todo` |
| [pi-vision-tools](./pi-vision-tools/README.zh.md) | `describe_image` 工具——将图像分析委托给视觉模型 | `@yandy0725/pi-vision-tools` |
| [pi-web-tools](./pi-web-tools/README.zh.md) | websearch + webfetch 工具 | `@yandy0725/pi-web-tools` |

> `pi-memory` 已迁往 [simple-memory](https://github.com/yandy/simple-memory)。
> `pi-container-sandbox` 已退役：npm 包标记为 deprecated，源码保留在 git 历史中（`pi-container-sandbox-v1.3.0`）。
> `pi-superpowers` 已退役：npm 包标记为 deprecated，源码保留在 git 历史中（`pi-superpowers-v0.7.3`）；skills 请改用上游 [obra/superpowers](https://github.com/obra/superpowers)。
> `pi-checkpoint` 在首次发布前退役：从未发布到 npm，源码保留在 git 历史中。

## 开发

```bash
npm ci                    # 安装所有依赖（根目录 + 所有工作区）
npm run typecheck         # 类型检查所有包
npm run lint              # Biome 代码检查
npm run format            # 格式化所有包
npm test                  # 运行所有测试
```

## License

MIT —— 仓库根目录的 [LICENSE](./LICENSE) 覆盖本 monorepo 中的所有包，各包不各自保存副本；
发布时由 `prepack` 把根 LICENSE 注入到每个 tarball 中。
