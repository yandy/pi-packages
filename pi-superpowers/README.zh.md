# pi-superpowers

Superpowers 技能包 — 为 pi 提供结构化的开发工作流技能。

## 安装

```bash
pi install npm:@yandy0725/pi-superpowers
```

## 配套包

Superpowers 工作流可能会分派子代理或跟踪任务。如需完整功能，请安装：

```bash
pi install npm:@yandy0725/pi-subagents
pi install npm:@yandy0725/pi-todo
```

## 技能

本包从 [Superpowers](https://github.com/obra/superpowers) 搬运以下技能，均以 `supo-` 为前缀：

| 技能 | 描述 |
|------|------|
| `/skill:supo-brainstorming` | 实现前探索用户意图、需求和设计 |
| `/skill:supo-systematic-debugging` | 系统化调试，定位根本原因 |
| `/skill:supo-writing-plans` | 从 spec 编写详细实现计划 |
| `/skill:supo-test-driven-development` | 测试驱动开发工作流 |
| `/skill:supo-using-git-worktrees` | 通过 git worktree 创建隔离工作区 |
| `/skill:supo-verification-before-completion` | 完成前验证工作正确性 |
| ... | 以及其他 |

## 斜杠命令

- `/supo <task>` — 根据任务类型分派到对应的 Superpowers 工作流

## 开发

从上游更新技能：

```bash
npm run download-skills
```

此命令会 clone [obra/superpowers](https://github.com/obra/superpowers) 仓库，将技能目录复制并添加 `supo-` 前缀，同时更新 SKILL.md 的 frontmatter 和交叉引用。

## 许可证

MIT
