# download-skills.mjs — Mono/Multi 参数与 Skills 获取重构设计

**Date:** 2026-07-28
**Status:** Approved
**Supersedes (partially):** 2025-06-27-pi-dingtalk-design.md（skills 获取模型部分）

## 背景与动机

`pi-dingtalk/scripts/download-skills.mjs` 原先从本地 `~/.dws/skills/multi/` 拷贝 skills 到 `skills/`。存在两个问题：

1. **单一模式**：只支持 `multi`（多个独立 skill 子目录），但 dingtalk-workspace-cli 同时提供 `mono`（单一 skill 结构）。无法选择。
2. **依赖已装 CLI**：脚本依赖 `~/.dws/skills/multi` 已存在（即用户已全局安装 `dingtalk-workspace-cli` 并跑过 postinstall）。若未装，只报错提示手动安装，不自助。

### 关键发现

调查 `dingtalk-workspace-cli` 包后发现：

- `dws-skills.zip` 是该包**自带静态 asset**（1.5MB，发布时打包在 `assets/` 下），不是运行时下载的。`install.js` 的 `extractSkills` 仅本地解压该 zip，无网络请求。
- zip 内部结构含 `mono/` 与 `multi/` 两棵子树，与 `~/.dws/skills/{mono,multi}/` 一一对应。
- 该包 `package.json` 有 `postinstall: node install.js`，其中 `cacheUserSkills()` 会把 zip 解压缓存到 `~/.dws/skills/{mono,multi}/`。

**结论**：若目的只是"拿 skills 文件"，无需"安装整个 CLI"（含平台二进制、postinstall）。skills.zip 是包内置的。这为重构获取模型提供了依据。

## 目标

1. 为 `download-skills.mjs` 增加 `--mono` / `--multi` 命令行参数。
2. 重构 skills 获取模型：从"依赖已装 CLI 的 `~/.dws/skills/`"改为"脚本自行从 npm 下载包并解压 skills.zip"，不再依赖本地预装。
3. 默认行为为 `--mono`。

## 非目标

- 不引入测试框架（保持 pi-dingtalk"纯 skills 集合，无测试框架"定位，用户明确选择）。
- 不重构 scripts 为多文件（保持单文件脚本）。
- 不改变 skills/ 内容本身的管理方式（仍不入 git，由脚本生成）。

## 命令行接口

```
用法：node scripts/download-skills.mjs [--mono | --multi]

  --mono   解压 dingtalk-workspace-cli 包内 mono/ 子树到 skills/dws/（默认）
  --multi  解压 dingtalk-workspace-cli 包内 multi/ 子树到 skills/（多 skill 子目录）

无参数 = --mono
```

### 参数解析（严格模式）

| 输入 | 结果 |
|------|------|
| （无参数） | `mode = "mono"` |
| 仅 `--mono` | `mode = "mono"` |
| 仅 `--multi` | `mode = "multi"` |
| 同时 `--mono --multi` | `exit 1`，stderr：`错误：不能同时指定 --mono 和 --multi` |
| 未知参数（如 `--foo`、或 `--mono=x` 带值形式） | `exit 1`，stderr：`错误：未知参数: --foo` |

## Skills 获取模型（方案 C：npm pack 直接解压）

### 执行流程

```
1. 解析参数得 mode（严格校验：冲突/未知参数报错退出）
2. 创建临时目录（mkdtempSync(tmpdir()/dws-skills-)）
3. 在临时目录执行（execSync 设 `cwd: tmpDir`，使 npm pack 的产物落在临时目录）：
   a. npm pack dingtalk-workspace-cli
      → 输出 <name>-<ver>.tgz 到临时目录（即 cwd）；捕获 stdout 末行得文件名
      → 失败（网络等）→ 抛错，finally 清理后 exit 1
   b. tar -xzf <tgz> package/assets/dws-skills.zip   （只解压需要的 zip）
      → 得到临时目录/package/assets/dws-skills.zip
   c. unzip -o <zip> -d <extract-dir>
      → 得到 mono/ multi/ LICENSE NOTICE SKILL.md references/ scripts/
4. 清空 SKILLS_DIR（rmSync 递归删除 + mkdirSync 重建）
5. 按 mode 拷贝：
   - mono  → 拷贝 <extract-dir>/mono/ 下所有内容到 SKILLS_DIR/dws/
            （产出 skills/dws/SKILL.md、skills/dws/references/ 等）
   - multi → 拷贝 <extract-dir>/multi/ 下所有子目录到 SKILLS_DIR/
            （产出 skills/dingtalk-aitable/ 等，与原逻辑产出一致）
6. 清理临时目录（finally，无论成功失败都清理）
7. stdout 输出 "Done."
```

### 关键技术点

- **临时目录**：`mkdtempSync(join(tmpdir(), "dws-skills-"))`，在 `try/finally` 中清理，避免污染 pi-dingtalk 目录。虽不引入测试，仍遵循文件系统卫生原则。
- **零外部依赖**：解压用系统 `tar -xzf`（GNU tar）+ `unzip`（Info-ZIP），与原脚本 `cp -r` 的 shell 命令风格一致。不引入 `adm-zip`/`yauzl` 等 npm 包。
- **按需解压**：`tar -xzf <tgz> package/assets/dws-skills.zip` 只提取 zip，不解压 tarball 内全部内容（含各平台 ~5MB 二进制，tarball 总计 58MB）。
- **npm pack 行为**：默认下载最新版本；文件名形如 `dingtalk-workspace-cli-1.0.54.tgz`，文件名输出到 stdout 末行需捕获；通过 `execSync('npm pack dingtalk-workspace-cli', { cwd: tmpDir })` 让产物直接落在临时目录。
- **错误处理**：npm pack 失败（无网络、包不存在等）→ exit 1，stderr 报错。tar/unzip 失败同理。

### 拷贝产出结构对比

| 模式 | 产出 |
|------|------|
| `--mono`（默认） | `skills/dws/SKILL.md`、`skills/dws/references/`、`skills/dws/scripts/`、`skills/dws/LICENSE`、`skills/dws/NOTICE` |
| `--multi` | `skills/dingtalk-aisearch/`、`skills/dingtalk-aitable/`、…（共 19 个 skill 子目录，各含 SKILL.md/references/scripts） |

`--mono` 用单一子目录名 `dws` 包裹 mono 内容，使最终结构与 multi 风格一致（都是 `skills/<name>/SKILL.md`）。

### 模式切换与清理

每次运行前清空 `skills/` 目录（rmSync 递归删除 + mkdirSync 重建）。保证：
- 模式切换（multi→mono 或反之）不残留旧文件。
- 幂等：重复运行结果一致。

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `pi-dingtalk/scripts/download-skills.mjs` | 重写：参数解析 + 方案 C 获取流程。唯一核心改动文件。 |
| `pi-dingtalk/README.md` | 小幅更新：澄清"使用 skills 需装 dingtalk-workspace-cli；开发时 download-skills 自动从 npm 拉取 skills"。 |
| `pi-dingtalk/README.zh.md` | 同上中文版。 |
| `pi-dingtalk/package.json` | 不变。保留 optional peerDependency（见下）。 |

## 依赖关系

**保留 `dingtalk-workspace-cli` 为 optional peerDependency：**

- `download-skills.mjs` 不再 `require`/`import` 此包（自己 npm pack 下载），所以下载阶段不强依赖它。
- 但 **skills 运行时依赖 `dws` 命令**（skills 内的 scripts 调用 `dws`）。保留 optional peer 表达此语义关联并提示用户安装。
- `peerDependenciesMeta.optional: true` 不变（不强制用户安装此包才能装 pi-dingtalk）。

## 约束

- 发布流程不变：`prepublishOnly: npm run download-skills`。发布环境需有网络访问（npm pack 需联网下载 tarball）。
- Release tag 格式不变：`pi-dingtalk-vX.Y.Z`。
- `skills/` 仍 gitignore，不入版本控制。
- 系统依赖：`tar`、`unzip`。运行环境需具备（macOS/Linux 基本自带）。

## 与原 spec 的关系

本设计部分覆盖 `2025-06-27-pi-dingtalk-design.md` 的以下部分：
- "Components → download-skills.mjs" 的逻辑（从"检查 ~/.dws/skills/multi 存在 → 拷贝"改为"npm pack → 解压 zip → 按 mode 拷贝"）。
- 原文"纯标准库：node:fs、node:child_process（cp -r）"更新为"node:fs、node:child_process（npm pack / tar / unzip）"。

其余（package.json 结构、.gitignore、Release 流程、Monorepo 集成）保持不变。

## 已确认的决策记录

| 决策点 | 选择 | 理由 |
|--------|------|------|
| mono 拷贝目标 | `skills/dws/`（包裹子目录） | 与 multi 风格一致（skills/<name>/SKILL.md） |
| 参数冲突/未知参数 | 严格报错退出 | 行为明确可预测 |
| 运行前清理 | 清空 skills/ 目录 | 模式切换不残留，幂等 |
| 测试策略 | 不引入测试框架 | 保持"纯 skills 集合"定位，用户明确选择 |
| skills 获取模型 | 方案 C：npm pack 下载不安装 | 目的只是拿 skills 文件，避免装整个 CLI（含平台二进制） |
| zip 定位方式 | npm pack tarball → 取 package/assets/dws-skills.zip | require.resolve 不可靠（可选 peer），npm pack 最干净不进 node_modules |
| zip 解压方式 | 系统 tar + unzip | 零 npm 依赖，与原脚本 shell 风格一致 |
