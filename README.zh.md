# pi-packages

一组互相独立的 [pi](https://pi.dev) 扩展包，按需取用、互不依赖。每个包只解决一个问题，`pi install` 装上就生效，不需要改 pi 本身。

[English](./README.md) | 中文

## 安装 pi

```bash
npm install -g @earendil-works/pi-coding-agent
```

## 包一览

| 包 | 它解决什么问题 | 额外依赖 |
|---|---|---|
| [pi-sandbox](./pi-sandbox/README.zh.md) | 让 agent 的 `bash` / `write` / `edit` 只能在允许的范围内动手 | 无（landlock 执行器随包分发） |
| [pi-subagents](./pi-subagents/README.zh.md) | 把活儿派给子代理并行做，按成本档位挑模型 | 无 |
| [pi-coding-tools](./pi-coding-tools/README.zh.md) | 按 AST/LSP 读代码，少读文件、少花 token | `ast-grep` CLI，及各语言的 LSP 服务器 |
| [pi-context-insight](./pi-context-insight/README.zh.md) | 一次 `/insight`，看清上下文由什么组成、钱花在哪 | 无 |
| [pi-notify](./pi-notify/README.zh.md) | 并行开多个 pi 时，知道哪个在等你 | Linux 需 `notify-send`；Windows 用自带 PowerShell 5.1 |
| [pi-todo](./pi-todo/README.zh.md) | 让 agent 边做边记，任务清单挂在编辑器上方 | 无 |
| [pi-ask-user](./pi-ask-user/README.zh.md) | 该问人的时候停下来问，而不是自己猜 | 无 |
| [pi-vision-tools](./pi-vision-tools/README.zh.md) | 非多模态模型也能看图 | 可选 `sharp`（发送前压缩） |
| [pi-web-tools](./pi-web-tools/README.zh.md) | 联网搜索与抓取网页 | 零配置可用；可选 `DEEPSEEK_API_KEY` / `ALIYUN_API_KEY` |

## 几个值得说的包

### pi-sandbox — 进程级沙箱

给模型发起的 `bash` / `write` / `edit` 设进程级限制，按平台挑执行器：Linux 上是 bwrap，回退 landlock；macOS 是系统自带的 seatbelt；Windows 是受限令牌加 Low 完整性标签。默认档 `workspace-write` 下工作区、`/tmp` 和额外授权的目录可写，其余宿主文件只读；没有可用执行器的平台上它**拒绝执行**，绝不静默裸跑。

路径是透明的——项目和工具命令不用为此改一行，也没有容器那层路径映射、镜像维护和启动延迟。提权是 denial-first 的：模型不能「预防性」带上提权参数，只有本会话真的被拒过一次同类操作才会弹审批，`Deny` 还可以附一句理由回传给模型，让它明白为什么被拒而不是换个写法反复试探。`/permission` 三档切换即时生效，父会话和所有子代理一起。

两件必须知道的边界：它只约束模型发起的动作，你自己敲的 `!命令` 走的是你自己的 shell；读始终不受限（能读到你有权读的一切），网络也不做隔离。

```bash
pi install npm:@yandy0725/pi-sandbox
```

### pi-subagents — 子代理与模型分档

在同一个 pi 运行时里起子代理（不是子进程），所以工具名、调用约定、UI 都一样。后台并行、超出并发数自动排队、运行中随时转向、中断后还能恢复，用量计入父会话的费用账本。

真正改变日常的是**三档模型**：在 `subagents.json` 里把 `fast` / `standard` / `advanced` 映射到真实模型，映射表会出现在 `subagent` 工具的 `model` 参数描述里，代理自己就能判断「找文件用 fast、做架构评审用 advanced」。

```json
{
  "modelTiers": {
    "fast": "deepseek-flash",
    "standard": "deepseek-flash",
    "advanced": "qwen3.8-max"
  }
}
```

没有 `model_tier` 这种额外参数；没配置的档位根本不会出现在参数描述和提示里，也不会有别的模型悄悄顶替；agent 的 frontmatter 写死了模型时永远以它为准。全局 `~/.pi/agent/subagents.json` 与项目 `.pi/subagents.json` 按**档位**合并，项目里只改一档，不用把另外两档再抄一遍。

```bash
pi install npm:@yandy0725/pi-subagents
```

### pi-coding-tools — 按结构理解代码

五个工具，共同点是省 token：`ast_grep_search` 按 AST 结构搜代码，不会误命中注释和字符串；`ast_grep_replace` 做结构重写，默认 dry-run；`lsp_symbols` 只取文件骨架，比整份 `read` 省约 95% token；`lsp_hover` 是唯一能回答「这个表达式什么类型」的工具；`lsp_navigate` 跨文件跳定义和找引用，按语义解析而不是同名文本匹配。覆盖 ts/tsx/js/python/java/kotlin/c/cpp，TypeScript ≥ 7 的项目直接用它内置的 native LSP，语言服务器一个都不用装。

```bash
pi install npm:@yandy0725/pi-coding-tools
```

### pi-context-insight — 上下文账本

`/insight` 出一份单文件 HTML，完全离线（严格 CSP、无外部请求、无 `eval`）。它逐请求重建模型当时真正收到的 prompt——系统提示词各分段、工具 schema、消息、工具结果——再与上一次请求做差，所以「上下文为什么涨这么快」有答案可查：16 类 token 拆分、缓存命中率、成本、耗时（模型 / 工具 / 其他，已剔除空闲）、窗口占用与压缩预留，每个子 Agent 另有一节。默认报告含原文，`--short` 结构完全一致但不含任何正文，可以放心发给别人。

```bash
pi install npm:@yandy0725/pi-context-insight
```

### pi-notify — 别让我轮流盯终端

同时开几个 pi 时，通知只在两种时刻来：有弹窗在等你（包括别的扩展发起的），或者一轮真的跑完了（带耗时和最后一句回复的摘要），每条都标明是哪个 session、哪个 pid。短于 10 秒的回合、被中断的回合、`custom` 回合和子代理都不发，不刷屏；`/notify` 可以运行时开关。投递是 fire-and-forget，通知发不出去也不会阻塞 agent 循环。

```bash
pi install npm:@yandy0725/pi-notify
```

### pi-todo — 一个工具，一块看板

`todo` 工具只有三种操作（规划、改一个、看进度），配一行挂在编辑器上方的看板。任务可以声明 `blockedBy` 依赖；状态从会话分支重建，所以 `/fork` 和 `/resume` 之后清单仍然是对的。

它还专治「最后一次性补账」：看板还有未完成任务、又一段时间没更新时，会往下一次请求里注入一条短提醒（首次 5 轮，之后 10 / 20 / 40 轮递增）。提醒只存在于本次请求，不落盘，长跑里不会累积成互相矛盾的「当下状态」。

```bash
pi install npm:@yandy0725/pi-todo
```

### pi-ask-user — 该问就停下来问

可搜索的分栏选项列表、多选、自由文本，选完还能补一句备注。超时和中断始终拥有最终裁决：非交互宿主不响应也不会把整轮挂住，本地超时（RPC 下默认 5 分钟）到点按取消结算——**不是**批准，命令与写入都不会发生。附带一个内置技能，把「高风险或需求模糊时先问人」变成固定的决策握手流程。

```bash
pi install npm:@yandy0725/pi-ask-user
```

### pi-vision-tools — 让看不到图的模型看图

调用方模型把图像和提示词交给 `describe_image`，配置好的视觉模型看一眼，把文本答案还回去。工具按调用方模型是否支持图像输入自动开关——你在用多模态模型时它根本不存在，切换模型就换行为，不需要手动开关。视觉模型可以写精确的 `provider/id`，也可以写 `haiku`、`qwen vl` 这样的模糊名；`compress` 和 `thinkLevel` 由调用方按需给，读坐标时就别压。

```bash
pi install npm:@yandy0725/pi-vision-tools
```

### pi-web-tools — 搜索与抓取

`websearch` 零配置可用——默认走 Exa 的免费层（150 次/天），中文查询可以回退到 DeepSeek 或阿里云，某个 provider 失败会自动落到下一个。`webfetch` 直接把 URL 的内容抓成可读 Markdown；本地抓取拿到的内容太薄（或需要 JS 渲染）时可以回退到服务端渲染。

```bash
pi install npm:@yandy0725/pi-web-tools
```

## 要求

以上都要求 **pi >= 1.5.0**。pi 安装扩展时不会校验这个 peer 下限，所以在更老的宿主上扩展可能在加载阶段就失败——装 pi-sandbox 的话尤其注意，此时 `bash` / `write` / `edit` 会静默回落到未受限的内建实现，装完先用 `/permission` 确认它真的生效。

## 开发

本仓是 npm workspaces monorepo。

```bash
npm ci                    # 安装所有依赖（根目录 + 所有工作区）
npm run typecheck         # 类型检查所有包
npm run lint              # Biome 代码检查
npm run format            # 格式化所有包
npm test                  # 运行所有测试
```

## License

MIT —— 仓库根目录的 [LICENSE](./LICENSE) 覆盖本 monorepo 中的所有包，各包不各自保存副本；
发布时由 `prepack` 把根 LICENSE 注入到每个 tarball 中。
