# Sandbox 动态 Skill Mount — 设计规格

## 背景

pi 从 **6 个来源** 发现 skill（npm package、`~/.agents/skills/`、`~/.pi/agent/skills/`、项目 `.agents/skills/`、settings 配置等），但当前 sandbox 的 `discoverSkillMounts()` 只静态扫描 `~/.agents/skills/` 和 `~/.pi/agent/skills/` 两个目录。其他来源的 skill 不会被挂载到容器内，导致 `read /skills/<name>/SKILL.md` 失败。

## 目标

1. 自动发现所有 pi 已加载的 skill，挂载到容器内 `/skills/<name>/`
2. 修正 system prompt 中 `<location>` 指向容器内路径
3. `skillMounts` 与 `userMounts` 明确分离，消除 `/skills/` 前缀猜测

## 架构

两阶段 skill 处理：

```
session_start                          before_agent_start
─────────────                          ──────────────────
ctx.getSystemPrompt()                  event.systemPrompt
  │                                       │
  ▼                                       ▼
parseAvailableSkills()                 构建 filePath→name 映射
  │ (解析 <available_skills> XML)         │
  ▼                                       ▼
skillsToMountSpecs()                   fixLocationPaths()
  │ (dirname → /skills/<name>, ro)       │
  ▼                                       ▼
DockerRuntime extraMounts              构建 skill/user info
  │                                       │
  ▼                                       ▼
setSbx({ skillMounts, userMounts })    return { systemPrompt }
```

关键时序约束：
- `session_start`：只能**读** `ctx.getSystemPrompt()`，不能修改 prompt
- `before_agent_start`：可以 `return { systemPrompt: ... }` 修改 prompt
- 容器必须在 `session_start` 创建，所以 mount 发现必须在 `session_start` 完成

## 类型变更

```typescript
// SbxSession — 拆分明确意图
interface SbxSession {
  skillMounts: MountSpec[];  // 新增：自动发现的 skill，始终 /skills/<name>, ro
  userMounts: MountSpec[];   // 新增：用户 sandbox.json 配置
  // mounts: MountSpec[];    // 移除
}
```

`SbxHandle.mounts`（ops 层）保持 flat `MountSpec[]` 不变。调用方在传入时合并 `[...sbx.skillMounts, ...sbx.userMounts]`。

## `src/skills.ts` 新 API

### `parseAvailableSkills(systemPrompt: string)`

从 system prompt 的 `<available_skills>` XML 解析所有 skill：

```xml
<available_skills>
  <skill>
    <name>ask-user</name>
    <description>...</description>
    <location>/home/user/.pi/.../skills/ask-user/SKILL.md</location>
  </skill>
</available_skills>
```

返回 `Array<{ name: string; filePath: string }>`，filePath 是 SKILL.md 的绝对路径。
- systemPrompt 为空 → throw
- 无 `<available_skills>` 块 → throw
- 单个 skill 的 name/location 为空 → 跳过该 skill

### `skillsToMountSpecs(skills)`

将解析结果转为 Docker mount specs：

```
{ name: "ask-user", filePath: "/home/.../skills/ask-user/SKILL.md" }
  → { source: "/home/.../skills/ask-user", target: "/skills/ask-user", mode: "ro" }
```

始终用 `<name>` 作为 `/skills/<name>/` 路径（而非目录名），保证 prompt 中 `<name>` 与 `<location>` 一致。

## `index.ts` 变更

### `session_start` handler

```
1. userMounts = sandbox.json runtime.mounts → MountSpec[]
2. skillMounts = skillsToMountSpecs(parseAvailableSkills(ctx.getSystemPrompt()))
3. 冲突检测：userMounts 的 target 不能与 skillMounts 的 target 重合
4. allMounts = [...skillMounts, ...userMounts] 给 DockerRuntime
5. setSbx({ skillMounts, userMounts, ... })
```

### `before_agent_start` handler

```
1. 重新解析 event.systemPrompt 中 <available_skills> XML，构建 filePath → name 映射
   （event.systemPrompt 是原始 prompt，扩展 handler 被顺序调用，各自接收原始值）

2. 用映射表替换 <location> 为容器内路径:
   <location>/skills/ask-user/SKILL.md</location>

3. 构建 skill info（直接读 sbx.skillMounts，不再按 /skills/ 前缀过滤）

4. 构建 user mount info（直接读 sbx.userMounts）

5. 替换 CWD 行，追加 skill/user info
```

注：不在 `SbxSession` 中额外存储映射表——`before_agent_start` 收到完整原始 system prompt，重新解析即可。

## 移除的代码

- `discoverSkillMounts()` 函数及关联 import（`homedir`, `getAgentDir`, `existsSync`, `readdirSync`, `statSync`）
- `sbx.mounts.filter(m => m.target.startsWith("/skills/"))` 前缀猜测逻辑

## 不变的部分

- `MountSpec`、`MountConfig` 类型
- `sandbox.json` 配置格式
- `DockerRuntime` 接口
- 路径映射函数（`hostToContainer`、`containerToHost`）
- 外部路径审批机制（`PathApprovalStore`）
- `SbxHandle.mounts` 类型（flat `MountSpec[]`）
- `src/ops.ts`、`src/paths.ts`、`src/runtime.ts`、`src/config.ts` 文件

## 边界情况

| 场景 | 行为 |
|------|------|
| `ctx.getSystemPrompt()` 为空 | `parseAvailableSkills` throw → sandbox 启动失败 |
| 无 `<available_skills>` 块 | throw → sandbox 启动失败 |
| `<name>` 与目录名不一致 | 始终用 `<name>` 作为 `/skills/<name>/` |
| `<location>` 中 skill name 无法从路径提取 | 保留原 `<location>` 不变 |
| user mount target 与 skill mount target 冲突 | throw → 提示修改 sandbox.json |
| 运行时新增/删除 skill | 需重启 session 才生效 |
