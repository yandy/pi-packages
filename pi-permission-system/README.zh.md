# pi-permission-system

[Pi](https://pi.dev) 编程 agent 的权限执行扩展。提供集中式、确定性的权限门控，覆盖工具调用、bash 命令、MCP、skill 及特殊操作。

## 功能

- **allow / ask / deny** 三种权限状态，通过 UI 确认对话框在工具调用时执行
- **Agent 启动前隐藏禁用工具** — 避免浪费回合探测被禁用的工具
- **Bash 命令控制**，支持通配符模式匹配（`git *: ask`、`rm -rf *: deny`）
- **MCP 和 skill 访问门控**，精细到 server、tool、skill 名称级别
- **跨切面 `path` 规则** — 在所有工具和 bash 中一揽子拒绝 `.env`、`~/.ssh/*` 等敏感文件，且与 symlink 解析后的路径同时匹配
- **外部目录守护** — 在文件工具或 bash 触及工作树外部时弹出提示
- **故障安全（fail closed）** — 内部门控错误会阻断工具；无法解析的 bash 命令提示用户而非静默放行
- **子代理 `ask` 转发** — `ask` 策略在子会话中通过父级 UI 同样生效
- **原生集成 `@yandy0725/pi-subagents`** — 进程内子会话自动注册，无需额外配置

## 安装

```bash
pi install npm:@yandy0725/pi-permission-system
```

## 快速开始

1. 创建全局配置文件 `~/.pi/agent/extensions/pi-permission-system/config.json`：

```jsonc
{
  "permission": {
    "*": "allow",
    "path": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    "bash": {
      "*": "ask",
      "rm -rf *": "deny",
      "sudo *": "ask"
    },
    "external_directory": "ask"
  }
}
```

2. 启动 Pi — 扩展自动加载并执行策略。

## 权限状态

| 状态 | 行为 |
|------|------|
| `allow` | 静默放行 |
| `deny` | 阻止并返回错误信息 |
| `ask` | 通过 UI 弹窗请求用户确认 |

弹窗出现时，可单次批准或将模式加入当前会话的允许列表。

## 配置

配置按作用域分别存放：

| 作用域 | 路径 |
|--------|------|
| 全局 | `~/.pi/agent/extensions/pi-permission-system/config.json` |
| 项目 | `<cwd>/.pi/extensions/pi-permission-system/config.json` |

项目配置覆盖全局。四个层级按"最严格优先"组合：`path` → `external_directory` → 各工具自身模式 → `bash` 命令模式。

`path` 切面作用于**所有**文件访问 — 工具、bash、MCP 及扩展 — 是保护 `.env`、`~/.ssh/*` 等敏感文件的最佳位置。同时匹配引用路径和 symlink 解析后的路径。

`external_directory` 切面控制是否允许访问工作树外部：

```jsonc
{
  "permission": {
    "external_directory": {
      "*": "ask",
      "~/.cargo/registry/*": "allow"
    }
  }
}
```

## 开发

```bash
npm run typecheck        # tsc --noEmit
npm run check            # biome check
npm test                 # vitest run
```

## 致谢

本项目是 [@gotgenes/pi-permission-system](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)（作者 [Chris Lasher](https://github.com/gotgenes)）的友好分支，后者源自 [MasuRii/pi-permission-system](https://github.com/MasuRii/pi-permission-system)。感谢所有原作者的工作使本包成为可能。

## 许可证

MIT
