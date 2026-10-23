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
| `/skill:supo-writing-plans` | 从 spec 编写精简实现计划 |
| `/skill:supo-test-driven-development` | 测试驱动开发工作流 |
| `/skill:supo-using-git-worktrees` | 通过 git worktree 创建隔离工作区 |
| `/skill:supo-verification-before-completion` | 完成前验证工作正确性 |
| `/skill:supo-diagnosing-superpowers` | 复盘出错的会话，以证据为依据生成诊断报告 |
| `/skill:supo-writing-skills` | 编写、修改并用子代理压测技能 |
| ... | 以及其他 |

## 斜杠命令

- `/supo <task>` — 根据任务类型分派到对应的 Superpowers 工作流

## 开发

技能全部来自上游仓库，本包不自行编写。升级到新的上游版本分两步：

1. 先改 `skills.config.json`：
   - `ref` —— 要跟的上游 tag（如 `v7.0.1`），可以是上游仓库里存在的任意 tag / 分支 / commit-ish
   - `skills` —— 与上游 `skills/` 目录保持同步：新增技能要加名字，上游删掉的要去掉
2. 然后运行：

```bash
npm run download-skills
```

脚本会按 `ref` clone [obra/superpowers](https://github.com/obra/superpowers)（缓存在 `/tmp/pi-superpowers-cache`），把列表里每个技能目录复制为带 `supo-` 前缀的目录，重写 SKILL.md 的 frontmatter 名称与交叉引用，并删除已不在列表中的 `supo-*` 目录。重复执行是幂等的，改到一半重跑也安全。

之后请审阅 diff：上游发版有时会重构某个技能（文件移入 `references/`、文档被删）或改变 README 描述所指的行为。

## 许可证

MIT
