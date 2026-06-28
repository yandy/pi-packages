# pi-ask-user: 配置文件配置方式

## 需求

为 `pi-ask-user` 增加配置文件配置方式，优先级低于环境变量、高于默认值。用户可以通过 JSON 文件设置 `displayMode`、`overlayToggleKey`、`commentToggleKey`，无需每次都设环境变量。

## 配置文件

### 路径

| 级别 | 路径 |
|------|------|
| User（全局） | `~/.pi/agent/ask-user.json` |
| Project（项目） | `<cwd>/.pi/ask-user.json` |

Project 文件中的字段覆盖 User 文件中同名字段（shallow merge）。

### 格式

```json
{
  "displayMode": "inline",
  "overlayToggleKey": "alt+h",
  "commentToggleKey": "alt+c"
}
```

所有字段可选。未写的字段不参与优先级链。

### 字段说明

| 字段 | 类型 | 有效值 |
|------|------|--------|
| `displayMode` | `string?` | `"overlay"` \| `"inline"` |
| `overlayToggleKey` | `string?` | 合法快捷键，如 `"alt+o"`、`"ctrl+shift+h"`、`"off"` |
| `commentToggleKey` | `string?` | 同上 |

## 优先级链

```
call param > env var > project config (.pi/ask-user.json) > user config (~/.pi/agent/ask-user.json) > default
```

### displayMode 示例

| call param | env var | project | user | 最终值 |
|-----------|---------|---------|------|--------|
| — | — | — | — | `"overlay"` |
| — | — | — | `"inline"` | `"inline"` |
| — | — | `"overlay"` | `"inline"` | `"overlay"`（project 覆盖 user） |
| — | `"inline"` | `"overlay"` | — | `"inline"`（env 覆盖 project） |
| `"overlay"` | — | `"inline"` | — | `"overlay"`（call param 最高） |

### overlayToggleKey / commentToggleKey 示例

`resolveShortcut(paramValue, envValue, configValue, defaultSpec)` 按顺序选取第一个有效值。

| paramValue | env var | config | default | 最终值 |
|-----------|---------|--------|---------|--------|
| — | — | — | `"alt+o"` | `"alt+o"` |
| — | — | `"alt+h"` | `"alt+o"` | `"alt+h"` |
| — | `"alt+x"` | `"alt+h"` | `"alt+o"` | `"alt+x"` |
| `"off"` | — | — | `"alt+o"` | disabled（call param 最高） |

## 实现

### 新增函数

`loadAskUserConfig(cwd?: string): Partial<ParsedAskUserConfig>`

- 读取 `~/.pi/agent/ask-user.json`（User 级），JSON.parse
- 如果 `cwd` 非空，读取 `<cwd>/.pi/ask-user.json`（Project 级），shallow merge 覆盖 User 字段
- 文件不存在或解析失败时静默忽略（相当于返回 `{}`）
- 返回扁平对象：`{ displayMode?, overlayToggleKey?, commentToggleKey? }`

### 修改点

1. **`resolveShortcut` 签名**：在 `envValue` 和 `defaultSpec` 之间插入 `configValue?: string | null`

2. **`execute` 中的 `effectiveDisplayMode`**：
   ```
   displayMode ?? envDisplayMode ?? configDisplayMode ?? "overlay"
   ```

3. **`execute` 中的 `shortcuts` 构建**：
   ```
   resolveShortcut(overlayToggleKey, envValue, configValue, DEFAULT_OVERLAY_TOGGLE_KEY)
   ```

### 读取时机

在 `execute()` 中读取，与 env var 解析同级。`ctx.cwd` 此时可用。JSON 文件 ≤1KB，每次调用读取不构成性能问题。

### 错误处理

- 文件不存在 → 静默跳过（`{}`）
- JSON 解析失败 → 静默跳过（`{}`）
- 字段类型不符 → 静默忽略该字段

配置文件的错误**不影响**工具正常使用，仅等效于未配置。

## 测试

| 用例 | 场景 |
|------|------|
| 无配置文件 | 和现有行为一致（零影响） |
| User 配置文件生效 | env var 未设时，从 `~/.pi/agent/ask-user.json` 读取 |
| Project 覆盖 User | `.pi/ask-user.json` 覆盖 User 文件同名字段 |
| env 覆盖 config | env var 设了以后，config 文件被忽略 |
| call param 覆盖一切 | 调用参数传了以后，env + config 都被忽略 |
| JSON 解析错误 | 静默 fallback 到下一优先级 |
| 文件不存在 | 静默 fallback 到下一优先级 |

## 不做的

- 不支持嵌套 JSON 结构（用户确认用扁平格式）
- 不支持 pi `settings.json`（用户确认用独立文件）
- 不热加载配置文件（每次工具调用时重新读取）
- 不暴露 `pi config` CLI 命令（只读文件，用户自行编辑）

## 文档

更新 README（`pi-ask-user/README.md` 和 `pi-ask-user/README.zh.md`），在"配置"章节补充配置文件方式，说明：
- 配置文件路径
- 优先级链
- 示例 JSON
