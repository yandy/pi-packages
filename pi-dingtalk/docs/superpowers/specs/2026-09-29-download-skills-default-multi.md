# download-skills.mjs — 默认模式改为 multi

**Date:** 2026-09-29
**Status:** Approved
**Supersedes (partially):** 2026-07-28-download-skills-mono-multi-design.md（仅"默认行为"部分）

## 背景

`2026-07-28` 设计引入了 `--mono` / `--multi` 参数，并把默认行为定为 `--mono`（产出单一 `skills/dws/` 子树）。

实际使用中，pi-dingtalk 定位为"钉钉 workspace skills 集合"，multi 结构（19 个独立 skill 子目录，如 `skills/dingtalk-aitable/`）才是期望的分发形态：每个产品领域一个 skill，`pi.skills: ["./skills"]` 可被 pi 逐个发现。mono 的单一 `dws` skill 反而需要用户显式指定 `--mono` 才用得上。

## 变更

1. `parseArgs` 无参数时返回 `"multi"`（原为 `"mono"`）。
2. 用法提示从 `[--mono | --multi]` 调整为 `[--multi | --mono]`，把默认项放前面。

其余行为不变：

- 显式 `--mono` / `--multi` 语义不变。
- 冲突（`--mono --multi`）与未知参数仍严格报错退出。
- 每次运行前清空 `skills/`，模式切换无残留。

## 影响

| 场景 | 变更前 | 变更后 |
|------|--------|--------|
| `npm run download-skills`（无参数） | `skills/dws/` | `skills/dingtalk-*/` 等 19 个 skill 子目录 |
| `prepublishOnly`（无参数） | 发布 mono 结构 | 发布 multi 结构 |
| `npm run download-skills -- --mono` | mono | mono（不变） |
| `npm run download-skills -- --multi` | multi | multi（不变） |

`skills/` 仍不入 git，由脚本生成；本变更不涉及 package.json、README、发布流程（Release tag 仍为 `pi-dingtalk-vX.Y.Z`）。

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `pi-dingtalk/scripts/download-skills.mjs` | `parseArgs` 默认返回值与 usage 文本 |
| `pi-dingtalk/docs/superpowers/specs/2026-09-29-download-skills-default-multi.md` | 新增（本文件） |

## 决策记录

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 默认模式 | `multi` | pi-dingtalk 是 skills 集合，multi 结构即期望分发形态 |
| 是否保留 mono | 保留为显式参数 | mono 仍对"只想装单个 dws skill"的用户有用 |
| 旧 spec 处理 | 不修改，新增本文档部分 supersede | 历史 spec 作为决策记录保留 |
