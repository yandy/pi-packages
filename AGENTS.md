发布新版本请参考 [docs/guides/release.md](docs/guides/release.md)。

## 新建 Package

monorepo 中所有 pi package 的统一规范请参考 [docs/guides/pi-package-spec.md](docs/guides/pi-package-spec.md)，新建、维护、重构均以此为准。

## 编写测试

测试规范（环境隔离、文件系统、getAgentDir 等）请参考 [docs/guides/testing.md](docs/guides/testing.md)。

## Git Worktree

本项目使用 `.worktrees/` 目录存放 git worktree，已加入 `.gitignore`。创建 worktree 时无需重复检查。
