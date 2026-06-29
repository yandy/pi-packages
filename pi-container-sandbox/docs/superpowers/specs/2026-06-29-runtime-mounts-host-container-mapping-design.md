# runtime.mounts 支持 host→container 路径映射

## 背景

当前 `runtime.mounts` 的类型为 `string[]`，但它的实际语义并非"直接挂载这些宿主机路径到容器"，
而是"额外的 skill 根目录"——扩展会扫描其中每个目录下的子目录，自动映射为 `/skills/<dirname>`：

```json
{ "runtime": { "mounts": ["/extra/tools"] } }
```

→ 扫描 `/extra/tools/my-sdk/` → 挂载为 `/skills/my-sdk`（只读）

用户无法自由指定"宿主机路径 X → 容器内路径 Y"的映射关系（例如挂载 `/data/projects` 到容器内的 `/projects`）。

## 目标

1. `runtime.mounts` 支持 host→container 路径映射，用户可以自由指定源/目标路径
2. 旧格式 `string[]`（纯路径列表）不再支持
3. 支持挂载权限控制：可指定只读（ro）或读写（rw），默认 ro

## 设计决策

| 决策 | 选项 |
|------|------|
| 技能自动发现 | **保留** — `~/.agents/skills/` 和 `${agentDir}/skills/` 继续自动扫描挂载 |
| 默认权限 | **ro** — 未指定 mode 时默认只读 |
| 配置格式 | **统一 MountConfig 对象** — `{ source, target, mode? }` |

## 类型设计

### 新增：MountConfig（config 层）

```typescript
// src/config.ts
export interface MountConfig {
    source: string;       // 宿主机路径
    target: string;       // 容器内路径
    mode?: 'ro' | 'rw';  // 默认 'ro'
}
```

### 修改：MountSpec（runtime 层，新增 mode 字段）

```typescript
// src/runtime.ts
export interface MountSpec {
    source: string;
    target: string;
    mode?: 'ro' | 'rw';  // ← 新增
}
```

### 修改：RuntimeConfig

```typescript
// 旧
mounts: string[];
// 新
mounts: MountConfig[];
```

## 数据流

```
sandbox.json  runtime.mounts (MountConfig[])
    │
    ├── 转换为 userMounts: MountSpec[]（mode 缺省补 'ro'）
    │
    └── discoverSkillMounts(): MountSpec[]（home 目录扫描，mode='ro'）
            │
            ▼
    allMounts = mergeMounts(skillMounts, userMounts)
    // 若 target 冲突 → 报错，提示用户修正配置
            │
            ▼
    DockerRuntime.extraMounts = allMounts
    Docker bind: ${source}:${target}:${m.mode === 'rw' ? 'rw' : 'ro'}

### 合并策略

`skillMounts`（自动发现）和 `userMounts`（sandbox.json）按 target 合并。
**若 target 冲突则报错**（而非静默覆盖），提示用户修正 sandbox.json 中的重复 target。
```

## 权限控制

### isReadOnlyMount

```typescript
// 旧：匹配到任何 mount 都返回 true
return true;

// 新：尊重 mode 字段
return m.mode !== 'rw';  // ro 或 undefined → true; rw → false
```

### Docker bind

```typescript
// 旧：硬编码 :ro
binds.push(`${m.source}:${m.target}:ro`);

// 新：读 mode
const mode = m.mode === 'rw' ? 'rw' : 'ro';
binds.push(`${m.source}:${m.target}:${mode}`);
```

### 写保护

`createWriteOps` / `createEditOps` 已使用 `isReadOnlyMount` 判断，无需变更。当一个 mount 被设为 `rw` 时，对它的写操作会自动放行。

## discoverSkillMounts 变更

- 移除 `additionalPaths?: string[]` 参数 — 用户自定义挂载现在通过 `MountConfig[]` 直接指定
- 修正 `~/.pi/agent/skills` 的硬编码：改用 `getAgentDir()` 计算 agent 目录
- 保留 `~/.agents/skills/` 扫描（homedir 固定前缀）
- 返回的 `MountSpec` 显式带 `mode: 'ro'`

## before_agent_start 消息更新

将挂载信息分为两类展示：

```
Agent skills are mounted read-only at /skills/ (...)
Read skill files via /skills/<name>/SKILL.md. Writing to /skills/ is forbidden.
Additional mounts: /data/projects → /projects (ro).
```

## 变更文件

| 文件 | 变更内容 |
|------|---------|
| `src/config.ts` | 新增 `MountConfig`；`RuntimeConfig.mounts` 类型改为 `MountConfig[]` |
| `src/runtime.ts` | `MountSpec` 加 `mode`；`startContainer` 的 bind 逻辑用 `mode` |
| `src/skills.ts` | `discoverSkillMounts()` 移除参数，返回带 `mode` 的 `MountSpec`，修正 agent dir 路径 |
| `src/paths.ts` | `isReadOnlyMount` 改为检查 `m.mode !== 'rw'` |
| `index.ts` | 导入 `MountSpec`；`session_start` 中 `MountConfig[]` → `MountSpec[]` + 合并逻辑；消息更新 |
| `tests/config.test.ts` | mounts 测试用例适配 `MountConfig[]` 格式 |
| `tests/skills.test.ts` | 适配新函数签名 |
| `tests/paths.test.ts` | 新增 `isReadOnlyMount` 对 rw/ro 模式的测试 |

## 不变的部分

- `DockerRuntime` 接口（除 `MountSpec` 类型扩展）
- `createWriteOps` / `createEditOps` / `createReadOps`
- 路径映射函数（`hostToRemote`、`remoteToHost`、`resolveExtraMountPath`）
- `/sandbox` 命令系统
- `path-approvals.json` 外部路径授权机制
