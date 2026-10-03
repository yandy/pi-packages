# pi-sandbox：`user_bash` 范围判定（不实现 handler，只补文档）设计

日期：2026-10-03
状态：已决定并落地（docs-only，`fa8619d7` 在 README EN/ZH 各加一段「适用范围仅限模型发起的动作」，随下次发版生效）
落点：`pi-sandbox/README.md:19`、`pi-sandbox/README.zh.md:19`

## 1. 问题

用户在 pi 里手输 `!cmd` / `!!cmd` 时，命令不受 pi-sandbox 约束。这是 agent 逃逸漏洞吗？要不要实现 `user_bash` handler？

## 2. 判定（已与用户确认）

- **不是逃逸漏洞**：`user_bash` **不是工具**，LLM 没有任何途径触发它。全仓 emit 点只有两处，都在用户/客户端侧：
  - `dist/modes/interactive/interactive-mode.js:5804` —— TUI 里用户输入 `!cmd` / `!!cmd`
  - `dist/modes/rpc/rpc-mode.js:441` —— RPC 客户端（IDE 等）发 `{"type":"bash"}`
  模型侧只会走 `bash` 工具（含 `ctx.executeTool("bash", …)` 的嵌套调用），全部命中 pi-sandbox 注册的工具 → 受约束。无 handler 返回 `{operations}` / `{result}` 时回落 `createLocalBashOperations()`，即宿主裸执行。
- **不实现 handler**（docs-only）：`!cmd` 是「用户自己的手」在敲，语义上是用户自己的 shell；沙箱的威胁模型是**约束 agent 进程**。
- 对照 pi-container-sandbox：它实现该 handler（`index.ts:137`）的**首要动机是路径 / 文件系统一致性** —— 容器内 workspace 是 `/workspace`，用户的 `!ls` 若落宿主机，就与模型看到的目录树、cwd、路径翻译错位。pi-sandbox 路径透明，没有这个问题。
- 历史背景（为何一度缺失）：`7083d0d5`（pi-container-sandbox 2.0.0 进程沙箱替换容器）丢掉了该 handler；`7dc9a0e0`（拆出 pi-sandbox@1.0.0）继承缺失；pi-container-sandbox 恢复容器实现时 handler 又回来。拆分 spec 与 pi-sandbox 三个 spec 全文未提 `user_bash` → 属**遗漏**，不是书面决策。

## 3. 复现 / 验证配方（非显而易见，重做成本高）

```bash
printf '%s\n' '{"id":"1","type":"bash","command":"readlink /proc/self/ns/mnt"}' > /tmp/in.jsonl
( cat /tmp/in.jsonl; sleep 10 ) | pi --mode rpc --no-session -e <repo>/pi-sandbox/index.ts
```

- **stdin 必须保持打开 ~10s**：否则 bash 异步执行、pi 在它输出前就退出（stdout 为空，容易误判成「没有输出」）。
- `{"id":"0","type":"get_commands"}` 可确认扩展已加载（输出里应出现 `permission`）。
- 对照实验：`-e` 一个只做 `pi.on("user_bash", () => ({ result: {…} }))` 的探针扩展 → 命令被接管；加载 pi-sandbox 时的输出与不加载**逐字一致**，证明它确实没处理该事件。

## 4. 若将来改主意要实现

`pi.on("user_bash", …)` 返回与 `bash` 工具同一 adapter（≥1.3.2）的 `operations`（`createSandboxBashOps({ mode / workspaceRoot / selected / … })`），并明确 read-only 语义：handler 抛错即**阻住**命令，不回落本地执行（见 pi 的 `extensions.md`）。
