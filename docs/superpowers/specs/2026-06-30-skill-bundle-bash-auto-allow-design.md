# Skill Bundle Bash 脚本自动放行

## 背景

`pi-permission-system` 的 `external_directory` gate 对 agent 访问 cwd 外部的路径进行权限检查。当 agent 执行 skill bundle 内的脚本（如 `bash ~/.pi/agent-code/git/.../scripts/review-package`）时，脚本路径在项目 cwd 之外，命中 `external_directory: { "*": "ask" }` 导致弹窗确认。

用户期望：skill bundle 内的脚本是 skill 的一部分，加载 skill 时就已建立信任，脚本执行不应再次确认。

## 目标

当 agent 通过 `bash` 工具执行一个位于已加载 skill 目录内的脚本文件时，`bash-external-directory` gate 自动放行该路径，不触发 `external_directory` 确认。

## 非目标

- 不改变 `read`/`find`/`grep`/`ls` 等工具对 skill 目录的访问行为（已由 `skill-read` gate 和 infrastructure 机制覆盖或不应覆盖）
- 不要求用户额外配置
- 不硬编码特定路径

## 设计

### 核心思路

`describeBashExternalDirectoryGate` 是 bash 的 external-directory gate 入口。它从 `BashProgram` 提取外部路径，交给 `selectUncoveredExternalPaths` 做 `external_directory` 策略检查。

改动：在调用 `selectUncoveredExternalPaths` 之前，用当前已加载 skill 的目录列表过滤掉 skill 内的路径。

### Skill 目录来源

`AgentPrepHandler` 在每次 `before_agent_start` 时解析系统 prompt 中的 `<available_skills>` 区块，生成 `SkillPromptEntry[]` 并写入 `PermissionSession`。每个 entry 包含：

- `name` — skill 名称
- `normalizedBaseDir` — skill 目录的规范化绝对路径（`dirname(normalizedLocation)`）

`normalizedBaseDir` 是目录而非文件，天然覆盖 skill 目录下的所有脚本、模板和子目录。

### 改动点

**1. `describeBashExternalDirectoryGate` 签名扩展**

新增可选参数 `skillDirs: string[]`。在 `selectUncoveredExternalPaths` 调用前，用 `isPathWithinDirectory` 过滤掉落在 skill 目录内的 `AccessPath`。

所有路径都被过滤时，返回 `null`（gate 不适用，跳过）。部分被过滤时，仅对剩余路径继续检查。

**2. `ToolCallGatePipeline.evaluate` 透传 skill 目录**

在 pipeline 中从 `this.inputs.getActiveSkillEntries()` 提取 `normalizedBaseDir`，传入 gate producer 闭包：

```typescript
const skillDirs = this.inputs.getActiveSkillEntries()
  .map(e => e.normalizedBaseDir)
  .filter(Boolean);
```

### 不涉及的改动

- `describeExternalDirectoryGate`（非 bash 工具的 external_directory gate）不变
- `describeBashPathGate`（bash path cross-cutting gate）不变，`path` surface 已有明确的 deny 规则不会误放行
- 配置 schema 不变
- 用户配置不变
