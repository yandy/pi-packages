# pi-context-insight

为当前 Pi session 生成独立、离线 HTML 洞察报告，解释当前上下文由什么组成、历史用量如何演进、工具/文件/命令做了什么，以及每个可发现的子 Agent 分别完成了哪些工作。

## 功能

- **一个命令，一个文件** — `/insight` 生成带内联 CSS 和 SVG 的 HTML；无 JavaScript、外部资源、模型调用或网络访问
- **Session 与模型账本** — prompt/output/cache token、成本、缓存命中率、分模型汇总和实际用量时间线
- **当前上下文组成** — 系统提示词、工具定义、用户/注入/压缩内容、推理、回答、工具调用与工具结果
- **活动分析** — 工具结果与耗时、文件操作与估算行数变化、命令状态与退出码
- **上下文事件与耗时** — compaction、context edit、分支摘要、模型/思考级别切换、墙钟及累计模型/工具耗时
- **子 Agent 报告** — 每个子 session 都有独立的元数据、用量、上下文、时间线、活动与事件视图
- **防御性输出** — 内容转义、严格 CSP、不包含原始 prompt/回复/工具结果/命令输出，并限制明细行数

## 安装

```bash
pi install npm:@yandy0725/pi-context-insight
```

或添加到 `~/.pi/agent/settings.json`：

```json
{
  "packages": ["npm:@yandy0725/pi-context-insight"]
}
```

需要 pi >= 1.5.0。

## 命令

```text
/insight
/insight path/to/report.html
```

无参数时，在当前工作目录写入 `pi-insight-<session-file-basename>.html`；内存 session 使用 `pi-insight-<session-id>.html`。

自定义路径相对于当前工作目录解析。目标文件已存在时会覆盖，与 `/export` 一致；不会自动创建父目录，也不会自动打开浏览器。

空 session（还没有 user 或 assistant 消息）会被拒绝并报 `Nothing to report yet - start a conversation first`，不写文件，与 `/export` 对未开始 session 的处理一致。

## 报告内容

| 区块 | 内容 |
|---|---|
| 总览 | Session 元数据、模型、工作目录、token/成本/缓存 KPI 和警告 |
| 用量账本 | Session 总量、父直接用量/转发子用量拆分、分模型汇总与逐条 usage 记录 |
| 当前上下文 | 宿主窗口占用，以及估算组成条与分类表 |
| 实际用量时间线 | 非缓存 input/cache write/cache read/output 堆叠柱、上下文事件标记与耗时摘要 |
| 子 Agent | 每个安全发现的子 session 对应一份可展开的完整报告 |
| 工具 | 按工具和层级统计调用、成功/错误/缺失结果/未完成及执行耗时 |
| 文件 | 读/写/编辑/搜索活动，以及基于参数估算的新增/删除行数 |
| 命令 | Shell 命令文本、状态、退出码与耗时，不含 stdout/stderr |
| 上下文事件 | Compaction、分支摘要、context edit、模型/思考级别切换与子 Agent 完成记录 |
| 数据说明 | 统计口径与隐私审查提醒 |

所有聚合都覆盖完整记录。每类活动/事件明细最多渲染 200 行，并注明省略数量；命令文本含省略号最多 1000 字符。

## 数据口径

### 全量历史与当前上下文

用量、工具/文件/命令活动、事件和耗时聚合 **session 全量 entries**，包括已压缩历史和其他分支。当前组成只使用应用 compaction 与 context edit 后的 **活动投影**。

### 实际值与估算值

- 时间线与账本来自 provider/usage entries 中的实际记录。Prompt token 为 `input + cacheRead + cacheWrite`，总 token 为 prompt 加 output。
- 当前组成根据投影内容估算，不会强制缩放到 provider 总量；未知工具定义显示 `—`，不会当成 0。
- 宿主上下文占用单独展示，因为 provider 序列化、缓存和尾部估算会使它与组成估算不同。
- 成本使用记录的 `usage.cost.total`，并标明 provider 报告、目录估算或混合口径。
- 行数变化根据 write/edit 参数估算，不是重新对文件系统做 diff。

### 父子记账

顶部总量使用父 session 账本，其中已经包含转发的子 Agent 用量。`Parent direct` 排除 `kind: "subagent"` entries，`Subagents forwarded` 只包含这些 entries。

每份子 Agent 报告都根据它自己的 JSONL session 计算，**不会再次加回**顶部总量。辅助摘要用量等差异可能使子账本与转发子集不同。

子 Agent 发现会合并完成记录与标准 `tasks/` session 目录，并在加载前校验 fork 血缘、realpath 边界、JSONL 后缀和子 header 的父身份。缺失或损坏的子 session 只产生 warning，不会阻断父报告。

`untracked` 表示没有完成记录：子 Agent 可能仍在运行、在前台运行、已完成但无记录或曾被中断；报告不会猜测具体状态。

## 隐私

HTML 不包含原始 prompt、助手回复、工具结果或命令输出，但仍可能包含工作目录、文件路径、命令文本、模型名和子 Agent 描述。**分享前请审查报告。**

## UI 能力

| 方法 | 守卫 | 非 TUI（RPC / 无界面） |
|---|---|---|
| `notify` | 无 | Fire-and-forget；RPC 客户端可转发或丢弃，print/JSON 不产生通知。HTML 生成不依赖通知送达 |

## License

MIT —— 仓库根目录的 LICENSE 覆盖本 package。
