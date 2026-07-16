# pi-packages

@yandy pi 扩展包的 Monorepo。使用 npm workspaces 管理。

## 包列表

| 包 | 描述 | npm |
|---|---|---|
| [pi-ask-user](./pi-ask-user/README.zh.md) | 交互式 ask_user 工具，支持可搜索分栏 UI、多选和自由文本 | `@yandy0725/pi-ask-user` |
| [pi-coding-tools](./pi-coding-tools/README.zh.md) | AST/LSP 代码智能工具（ast_grep_search/lsp_symbols/lsp_hover/lsp_navigate）+ ls/find/grep | `@yandy0725/pi-coding-tools` |
| [pi-container-sandbox](./pi-container-sandbox/README.zh.md) | Docker 沙箱扩展 | `@yandy0725/pi-container-sandbox` |
| [pi-dingtalk](./pi-dingtalk/README.zh.md) | 钉钉集成（AI 表格、日历、审批、文档等） | `@yandy0725/pi-dingtalk` |
| [pi-lark](./pi-lark/README.zh.md) | Lark/飞书集成 | `@yandy0725/pi-lark` |
| [pi-memory](./pi-memory/README.zh.md) | 基于文件系统的持久化记忆层，为 pi 编程代理提供跨会话记忆 | `@yandy0725/pi-memory` |
| [pi-permission-system](./pi-permission-system/README.zh.md) | 工具访问控制的权限系统 | `@yandy0725/pi-permission-system` |
| [pi-subagents](./pi-subagents/README.zh.md) | 进程内子代理核心，支持后台执行和类型化 API | `@yandy0725/pi-subagents` |
| [pi-todo](./pi-todo/README.zh.md) | 极简 todo 工具，带编辑器嵌入式小组件 | `@yandy0725/pi-todo` |
| [pi-vision-tools](./pi-vision-tools/README.zh.md) | `describe_image` 工具——将图像分析委托给视觉模型 | `@yandy0725/pi-vision-tools` |
| [pi-web-tools](./pi-web-tools/README.zh.md) | websearch + webfetch 工具 | `@yandy0725/pi-web-tools` |

## 相关项目

- [picode](https://github.com/yandy/picode) —— 为 coding 场景做了配置优化的预配置集合，包含精选的设置、模型配置、代理定义、技能、按键绑定和记忆管理。

## 开发

```bash
npm ci                    # 安装所有依赖（根目录 + 所有工作区）
npm run typecheck         # 类型检查所有包
npm run lint              # Biome 代码检查
npm run format            # 格式化所有包
npm test                  # 运行所有测试
```

## 发布

参见 [docs/guides/release.md](docs/guides/release.md)。
