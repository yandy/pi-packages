# 内置 Explore 代理只保留只读工具 — 设计

- 日期：2026-11-24
- 包：pi-subagents
- 状态：已实现

## 问题

`Explore` 的 `tools` 写死为 `read, bash, grep, find, ls`。其中 `bash` 与 `powershell` 是一对平台互斥的内置工具：

- 宿主 `bash` 工具在 win32 上依次找 Git Bash / MSYS2 / Cygwin / PATH 上的 `bash.exe`，找不到就抛 `No bash shell found`（`pi-coding-agent/dist/utils/shell.js:105`）；官方 Windows 指引反过来建议把父会话的 bash 换成 powershell（`defaultTools: ["read", "powershell", "edit", "write"]`，`docs/windows.md:45-53`）。
- `powershell` 工具在非 Windows 上直接抛 `The powershell tool is only available on Windows.`（同文件 `:125`）。

所以「把两个都写进列表」并不能修好：每个平台上子代理都会带着一个一调就抛错的 shell，而 shell 恰恰是模型最常调的工具。

更关键的是没有任何一层会纠正文案。`Explore` 用 `promptMode: "replace"`，`systemPromptOverride` 顶掉整段基础提示（`dist/core/resource-loader.js:492`），于是 `buildSystemPromptSections()` 走 customPrompt 分支，**不生成 `<tools>` / `<rules>` / `<docs>` 段**（`dist/core/system-prompt.js:80-104`）。宿主那句「Parse-shell 用于文件操作」的 rule 不存在，正文里那 4 处 `Bash` 是子代理唯一的 shell 说明：即使工具不可用，提示词照样宣称能用它执行 `git log`、`cat` 之类命令。

## 决策

`Explore` 只拿宿主的只读工具集，**不拿任何 shell**：

```ts
const EXPLORE_TOOL_NAMES = ["read", "grep", "find", "ls"];
```

正文随之收窄，并显式说明「没有 shell」：

- 删掉 4 处 shell 相关句子（`Use Bash ONLY for read-only operations` 两处、`NOT the bash find command`、`NOT bash grep/rg command`），`# Tool Usage` 改为四条对应的只读工具用法，新增 `ls` 一条。
- 开头一句把能力边界说完整：`You have no tool that can create, modify, or delete files, and no shell in which to run commands.`
- `STRICTLY PROHIBITED` 表删掉只在有 shell 时才可能违反的三条（redirect/heredoc 写文件、运行改变系统状态的命令、临时文件——保留创建临时文件一条）。
- `# Output` 增加一条：需要命令输出（git 历史、构建/测试结果）才能回答时，报为缺口而不是推测。

## 非目标

- 不引入「会话 shell 槽」（`tools: shell` 之类的解析期别名）。那是让子代理跟随父会话 shell 的方案，代价是 `tools` 语法多一种拼法、要同步 `validateToolList` 与 README 的拼法表；只读代理不需要 shell，就不必为此扩语法。
- 不跟随父会话的 shell，也不做平台嗅探（`process.platform === "win32" ? "powershell" : "bash"`）：只读能力不该依赖运行平台。
- 不改 `general-purpose`（它继承父会话工具集，shell 自然跟随父会话）。
- 不改 `promptMode`；`replace` 仍然是这个代理需要的形状。

## 已接受的代价

- **失去只能靠命令获得的信息**：`git log` / `git diff` / `git show`、`rg` 的高级用法、构建与测试输出。`grep` / `find` / `ls` / `read` 覆盖文件内容与布局，但覆盖不了历史与执行结果。
- 逃生口：用户自定义 `.md` 同名代理可写回旧集合（`tools: read, bash, grep, find, ls`），或只在自己的 Windows 机器上这么做。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/config/default-agents.ts` | `EXPLORE_TOOL_NAMES` 去掉 `bash`；注释说明平台互斥对；`Explore` 正文按上文改写 |
| `tests/config/default-agents.test.ts` | 列表断言改为四个；新增「不给 shell、正文不点名 bash/powershell、正文声明没有 shell」 |
| `tests/config/agent-types.test.ts` | `getToolNamesForType("Explore")` 断言同步 |
| `README.md` / `README.zh.md` | 默认代理表 `Explore` 行改为 `read, grep, find, ls` |
| `docs/superpowers/specs/2026-11-23-tool-inheritance-design.md` | 在该文 `Explore` 行处加一行指向本文（旧文是历史记录，不重写结论） |
