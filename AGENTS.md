发布新版本请参考 [docs/guides/release.md](docs/guides/release.md)。

## 新建 Package

monorepo 中所有 pi package 的统一规范请参考 [docs/guides/pi-package-spec.md](docs/guides/pi-package-spec.md)，新建、维护、重构均以此为准。

## 编写测试

测试规范（环境隔离、文件系统、getAgentDir 等）请参考 [docs/guides/testing.md](docs/guides/testing.md)。

## 扩展 UI（`ctx.ui` / `ctx.mode` / `ctx.hasUI`）

改动任何 `ctx.ui.*` 调用、或对 `ctx.mode` / `ctx.hasUI` 分支之前，先读 [docs/guides/pi-package-spec.md](docs/guides/pi-package-spec.md#ui-能力与跨模式降级) 的「UI 能力与跨模式降级」（含判据表与 RPC 能力矩阵）。两条最容易踩的：

- `ctx.hasUI` 在 RPC 下恒为 `true`：终端组件（`custom`、`setWidget(factory)`、`onTerminalInput`、`setFooter` / `setHeader`）必须用 `ctx.mode === "tui"` 守卫，否则在 RPC 宿主里被静默丢弃。
- 对话框（`select` / `confirm` / `input`）在 RPC 下只是把请求转发给客户端，必须传 `timeout`，否则客户端不响应就会永久挂起。

用到 UI 的包必须在 `README.md` / `README.zh.md` 各写一节 `## UI surface` / `## UI 能力`，逐方法写明守卫信号与非 TUI 降级行为。

## Git Worktree

本项目使用 `.worktrees/` 目录存放 git worktree，已加入 `.gitignore`。创建 worktree 时无需重复检查。
