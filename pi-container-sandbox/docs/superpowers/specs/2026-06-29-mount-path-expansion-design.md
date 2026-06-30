# runtime.mounts 路径展开（~ / 相对路径）

> **⚠ 2026-06-30 更新：** 此设计文档记录原始设计。当前实际行为已变更：
> - ✅ `~` 展开仍保留
> - ❌ `${userHome}` 支持已移除（不再展开，作为普通相对路径处理）
> - ✅ **新增**：`source` 和 `cache` 支持相对路径（基于 `hostCwd` 解析）
> - `expandPath(raw)` → `expandPath(raw, cwd?)`，`cwd` 为可选参数
>
> 详见 commit `82f2664`。

## 背景

`runtime.mounts` 的 `source` 字段和 `runtime.cache` 字段目前要求用户填写绝对路径。
用户在跨机器共享 `sandbox.json` 配置时（例如不同机器的 home 目录不同），硬编码绝对路径不够灵活。

## 目标

支持在 `source` 和 `cache` 字段中使用 `~` 和 `${userHome}` 占位符，
在配置加载时自动展开为当前用户的实际 home 目录。

## 设计决策

| 决策 | 选项 |
|------|------|
| 展开时机 | **config 层** — `loadSbxConfig()` 中展开，所有下游拿到绝对路径 |
| 展开语法 | `~` + `${userHome}`，大小写敏感 |
| 展开范围 | `source`（mounts）+ `cache` 字段。`target` 不展开（容器内路径） |
| ~otheruser | **不支持**，仅 `~` 和 `~/path` 展开 |
| 展开函数位置 | `src/paths.ts`，与其他路径工具函数同文件 |

## 类型设计

无类型变更 — `expandPath()` 输入 string 输出 string，`MountConfig.source` 和 `RuntimeConfig.cache` 类型不变。

## 数据流

```
sandbox.json
  runtime.mounts[].source: "~/data" | "${userHome}/tools"
  runtime.cache: "~/sandbox-cache"
    │
    ▼ loadSbxConfig()
    │ mergeGroup() 合并 global + project 配置
    │
    ▼ expandPath() 展开 source 和 cache
    │ ~ → homedir()
    │ ${userHome} → homedir()
    │
    ▼ 返回 SbxConfig（所有路径已是绝对路径）
    │
    ▼ index.ts session_start
    │ MountConfig[] → MountSpec[]（1:1 转换，不再做额外展开）
    │
    ▼ DockerRuntime.startContainer()
    │ Docker bind: /home/user/data:/projects:ro
```

## expandPath 函数

```typescript
// src/paths.ts
import { homedir } from "node:os";

export function expandPath(raw: string): string {
    const home = homedir();
    let result = raw;
    // ~ 和 ~/xxx → /home/user 和 /home/user/xxx
    if (result === '~' || result.startsWith('~/')) {
        result = home + result.slice(1);
    }
    // ${userHome} 占位符 → /home/user
    result = result.replace(/\$\{userHome\}/g, home);
    return result;
}
```

行为：

| 输入 | 输出 |
|------|------|
| `~` | `/home/yandy` |
| `~/data/projects` | `/home/yandy/data/projects` |
| `${userHome}/data` | `/home/yandy/data` |
| `${userHome}/a/${userHome}/b` | `/home/yandy/a//home/yandy/b` |
| `~otheruser/stuff` | `~otheruser/stuff`（不展开） |
| `/absolute/path` | `/absolute/path`（不展开） |

## 变更文件

| 文件 | 变更 |
|------|------|
| `src/paths.ts` | 新增 `expandPath()` 导出函数 |
| `src/config.ts` | `loadSbxConfig()` 中调用 `expandPath` 展开 `source` 和 `cache` |
| `tests/paths.test.ts` | 新增 `expandPath` 单元测试（6 个用例） |
| `tests/config.test.ts` | 新增配置加载时的路径展开集成测试（1 个用例） |

## 不变的部分

- `MountConfig` / `MountSpec` 接口
- `index.ts` — 拿到已展开路径，无需修改
- `runtime.ts` — Docker bind 逻辑不变
- `skills.ts` — `discoverSkillMounts()` 使用 `homedir()` 自行计算，不受影响
- `paths.ts` 其他函数（`toContainerPath`、`remoteToHost` 等）
- `/sandbox` 命令系统
