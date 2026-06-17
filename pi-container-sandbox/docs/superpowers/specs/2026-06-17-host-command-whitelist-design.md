# Host Command Whitelist

## Summary

当 agent 的 bash 工具执行的命令命中 `sandbox.json` 的 `hostCommands` 白名单时，直接在 host 执行，而非在 Docker 容器内执行。

## Motivation

某些命令行工具（如 `git`、`docker`、`npm`）在容器内执行可能因网络、权限、配置等原因受限或行为不一致。允许这些命令透传到 host 执行，利用 host 上已有的认证、缓存和环境。

## Design

### Matching rule

白名单匹配 bash 命令的第一个词（命令名）。例如白名单含 `git`，则 `git status`、`git clone ...` 都在 host 执行。仅作用于 agent 的 bash 工具调用，不影响用户的 `!` 命令和 `/sandbox exec`。

### Configuration

`SbxConfig` 新增可选字段 `hostCommands?: string[]`，通过 `.pi/agent/sandbox.json` 配置：

```json
{
  "hostCommands": ["git", "docker", "npm"]
}
```

不提供 CLI flag，仅通过配置文件管理。

### Files changed

| File | Change |
|------|--------|
| `src/config.ts` | `SbxConfig` 新增 `hostCommands?: string[]` |
| `src/paths.ts` | `toRemote` 重命名为 `hostToRemote`；新增 `remoteToHost()`：容器路径 → host 路径的反向映射 |
| `src/ops.ts` | `createBashOps` 重命名为 `createRemoteBashOps`；新增 `createHostBashOps()`：host 本地执行的 `BashOperations`；新增 `extractCommandName()`：从命令字符串提取命令名 |
| `index.ts` | bash 工具 `execute` 中按白名单路由：命中 → `createHostBashOps`，未命中 → `createRemoteBashOps`（容器）；`before_agent_start` prompt 追加白名单路径提示；引用更新 |
| `tests/paths.test.ts` | `toRemote` → `hostToRemote` 引用更新 |

### Path mapping

`BashOperations.exec(command, cwd, opts)` 的 `cwd` 参数可能是容器路径（如 `/workspace/src`），host 执行前需要通过 `remoteToHost` 映射：

- `/workspace` → `$hostCwd`
- `/workspace/src/...` → `$hostCwd/src/...`
- `/skills/<name>` → mount source 反查

### LLM prompt

在 `before_agent_start` 的 system prompt 末尾追加白名单提示，引导 LLM 对 host 命令使用相对路径：

```
The following commands run directly on the host (not inside the container):
  git, docker, npm

When using these commands, prefer relative paths (e.g. `src/foo.ts`)
rather than absolute /workspace paths, because they execute outside the
container where /workspace does not exist.
```

这样命令参数中的容器绝对路径问题通过 prompt 引导解决，无需在代码层做命令参数的路径映射。

### Routing flow

```
agent bash tool call
  → getSbx() → null? → localBash.execute (host, 无沙箱)
  → extractCommandName(command)
  → hostCommands.includes(cmdName)?
      → createBashTool(localCwd, { operations: createHostBashOps(hostCwd, mounts) })
      → createBashTool(localCwd, { operations: createRemoteBashOps(sbx) })
```

### extractCommandName

| Input | Output |
|-------|--------|
| `git status` | `git` |
| `  git add .` | `git` |
| `GIT_DIR=foo git log` | `git` |
| `/usr/bin/node` | `/usr/bin/node` |
| `npm` | `npm` |

## Testing

- `extractCommandName` 单元测试（纯函数）
- `remoteToHost` 单元测试（纯函数）
- `createHostBashOps` 单元测试：验证 cwd 映射 + 本地执行
- bash 工具白名单路由集成测试：命中 → host exec；未命中 → container exec

## Out of scope

- `/sandbox host-cmds` 管理命令（后续可加）
- 对用户 `!` 命令和 `/sandbox exec` 的透传
- CLI flag
