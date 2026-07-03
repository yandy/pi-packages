# pi-memory 手动测试方案

> 用于在真实 pi 会话中验证 pi-memory 的端到端行为。自动化单元测试覆盖各模块逻辑;本方案覆盖跨会话注入、命令交互、dream 整理等需要真实 pi 运行时才能验证的路径。

## 准备

### 1. 选择加载方式(二选一)

- **临时加载**(推荐测试用,不污染全局设置):

  ```bash
  cd /home/yandy/workspace/pri/pi-packages/.worktrees/feat/pi-memory
  pi -e ./pi-memory
  ```

- **正式安装**(测真实 `pi install` 流程):

  ```bash
  pi install /home/yandy/workspace/pri/pi-packages/.worktrees/feat/pi-memory/pi-memory
  ```

### 2. 建一个独立测试项目

避免和你真实项目的记忆混淆:

```bash
mkdir -p /tmp/mem-test && cd /tmp/mem-test && git init
```

该项目的记忆会存到 `~/.pi/memory/<hash12>/`(hash 由 git toplevel 算出)。测试后可直接 `rm -rf ~/.pi/memory/<hash>` 清理。

> 配置文件路径:全局 `~/.pi/agent/pi-memory.json`,项目 `<cwd>/.pi/pi-memory.json`(需项目受信任)。

---

## 阶段 1:memory 工具 — add(核心写入)

在测试项目里启动 pi(`pi -e ./pi-memory`,cwd = `/tmp/mem-test`),然后让 agent:

```
记住:这个项目用 make test 跑测试,需要先启动 docker-compose dev
```

**预期**:agent 调用 `memory add`,创建 topic 文件(如 `builds.md`),写 YAML frontmatter + 内容,并在 `MEMORY.md` 写入索引行。

**验证**:

- 工具结果显示 `Added to builds.md. Index now has 1 entries.`
- `/memory` 命令显示状态:enabled、Dir、`1/200 lines`、topic files 含 `builds.md`
- 文件系统:

  ```bash
  ls ~/.pi/memory/<hash>/        # 应有 MEMORY.md + builds.md
  cat ~/.pi/memory/<hash>/MEMORY.md
  cat ~/.pi/memory/<hash>/builds.md   # 应有 frontmatter
  ```

再让 agent 记 2-3 条不同主题(如 "我偏好简洁回复,不要尾部总结"、"staging 服务器 SSH 端口是 2222"),验证多 topic + 索引增长。

---

## 阶段 2:snapshot 注入(跨会话记忆)

**这是核心卖点,务必测。**

1. 在当前会话 add 几条记忆后,**退出 pi**(`/exit` 或 Ctrl+C)。
2. 重新在同一项目启动 `pi -e ./pi-memory`。
3. 不提任何上下文,直接问:

   ```
   这个项目怎么跑测试?
   ```

   **预期**:agent 应**直接引用**记忆里的内容(先启动 docker-compose → make test),因为它启动时 `MEMORY.md` 索引已注入 system prompt。可让它读对应 topic 文件确认细节。

4. **测 snapshot 冻结语义**:在当前会话里 add 一条新记忆,然后问 agent "你现在的记忆索引里有哪些条目?"——它应该**只看到会话启动时的快照**(不含刚 add 的新条目),因为 snapshot 不在会话中刷新。验证后退出重进,新条目应出现。

---

## 阶段 3:remove（按 entry 精确删除）

### remove 基础

先 add 两条记忆（同一 topic 或不同 topic），然后：

```
删掉关于 SSH Gotcha 的那条记忆
```

**预期**：agent 调 `memory remove entry="SSH Gotcha"`，索引行被删 + topic 文件中对应的 `## SSH Gotcha` 区块被删。

### 测多 entry topic 删一条后文件保留

对同一 topic add 两条 entry，然后删除其中一条：

**预期**：topic 文件仍存在，剩余 entry 保留，updated 日期刷新。

### 测最后一个 entry 删除后文件清理

对只有一个 entry 的 topic 执行 remove：

**预期**：topic 文件被删除，MEMORY.md 中不再引用该 topic。

### 测多匹配报错

在不同 topic 中 add 同 title 的 entry（如两个 `title="Config"`），然后 remove `entry="Config"`：

**预期**：工具报错 "multiple matches" + 列出涉及的 topic 文件列表。

### 测 entry 不存在报错

remove 一个不存在的 entry title：

**预期**：工具报错 "not found"。

---

## 阶段 4:search(两个 scope)

### scope=memory

```
搜一下记忆里关于 docker 的内容
```

**预期**：返回匹配的**完整 entry block**（整个 `##` 区域），而非仅上下文行。

### scope=sessions(pi 独有能力,需有历史会话)

1. 先在这个项目里聊几轮(产生 session JSONL),聊点具体内容比如 "我修过一个 deadlock 问题"。
2. 新开会话后:

   ```
   搜一下历史会话里有没有讨论过 deadlock
   ```

   **预期**:agent 调 `memory search scope=sessions query=deadlock`,返回匹配的 session 文件 + 日期 + 上下文摘要。验证它确实从 `~/.pi/agent/sessions/` 找到了内容。

---

## 阶段 5:read（加载 topic 或 entry）

### read topic

```
加载 debugging 这个 topic 的全部内容
```

**预期**：agent 调 `memory action="read" topic="debugging"`（支持有无 `.md` 后缀），返回该 topic 文件完整内容。

### read entry

先 add 几条记忆，然后：

```
加载 SSH Gotcha 这个 entry 的内容
```

**预期**：agent 调 `memory action="read" entry="SSH Gotcha"`，扫描所有 topic 文件，返回匹配的 `## SSH Gotcha` block。

---

## 阶段 6:/memory 命令

- `/memory` — 显示状态面板(enabled / Dir / 索引行数 / topic files / last dream)
- `/memory off` — 关闭。验证:后续 `before_agent_start` 不再注入(prompt 里无 Memory Index),且调 `memory add` 工具会抛 `Memory is disabled`。
- `/memory on` — 重新启用。

---

## 阶段 7:/dream(需真实模型 + API key)

**前置**:确保有可用模型 API key。可配置便宜模型加速:

```bash
# ~/.pi/agent/pi-memory.json
{ "dream": { "model": "deepseek/deepseek-v4-flash" } }
```

1. 先 add 5-8 条记忆,**故意制造重复/矛盾**(如两条都说 SSH 端口但数值不同、两条重复的构建命令)。
2. `/dream` → 确认对话框选 Yes。
3. **预期**:状态栏显示 `Consolidating memory...`,headless agent 跑一段时间,完成后 notify 整理摘要(合并 N 条、删除 N 条等)。
4. **验证**:

   ```bash
   cat ~/.pi/memory/<hash>/.dream-meta.json   # 应有 lastDreamAt + sessionCountAtDream
   cat ~/.pi/memory/<hash>/MEMORY.md          # 索引应被重组、去重
   ```

   重复/矛盾条目应被合并。`/memory` 的 `Last dream` 应更新。

### 测取消

`/dream` 开始后按 Esc,验证状态栏清除、无残留。

### 测无模型

把 `dream.model` 设成不存在的 `provider/id`,验证 `/dream` notify `No model available` 且不崩溃。

---

## 阶段 8:启动 nudge

nudge 条件:距上次 dream ≥ 24h 且 ≥ 5 个 session,或无 dream 记录且 ≥ 5 个 session。

快速触发(不用真等 24h):

```bash
# 删掉 dream meta,并造 5+ 个 session
rm ~/.pi/memory/<hash>/.dream-meta.json
# 在该项目多开几次 pi 会话(每次随便聊一句再退出)凑够 5 个 session
```

然后新启动 pi,**预期**启动时 notify:`💡 N sessions, M new entries since last dream. /dream`

---

## 阶段 9:配置与边界

- **项目级配置**:在 `/tmp/mem-test/.pi/pi-memory.json` 放 `{ "memIndexMaxLines": 3 }`,信任项目后验证 `/memory` 显示 3 上限、add 第 4 条触发容量错误(返回现有条目列表,agent 应 consolidate 重试)。
- **路径穿越**:让 agent `memory add topic="../escape.md"` —— 应被拒绝(safeTopicPath 抛错)。
- **非 git 项目**:在非 git 目录启动,验证 hash 用 cwd 路径计算,记忆仍正常存取。
- **rebrand 兼容**(可选):若有 rebrand 版 pi,memoryDir 应自动跟随 `CONFIG_DIR_NAME`。

---

## 清理

```bash
rm -rf ~/.pi/memory/<hash>          # 删测试项目记忆
# 若用了 pi install,卸载:pi remove /path/to/pi-memory
# (或从 settings.json 删 packages 条目)
```

---

## 测试结果记录

| 阶段 | 场景 | 结果(✓/✗) | 备注 |
|------|------|-----------|------|
| 1 | add 写入 + 索引 | | |
| 2 | 跨会话 snapshot 注入 | | |
| 2 | snapshot 冻结语义 | | |
| 3 | remove 按 entry 删除 | | |
| 3 | 多 entry topic 删一条文件保留 | | |
| 3 | 最后一个 entry 删除文件清理 | | |
| 3 | 多匹配报错 | | |
| 3 | entry 不存在报错 | | |
| 4 | search scope=memory（完整 entry block） | | |
| 5 | read topic | | |
| 5 | read entry | | |
| 6 | /memory 状态 / on / off | | |
| 7 | /dream 整理 + meta | | |
| 7 | /dream 取消 | | |
| 7 | /dream 无模型 | | |
| 8 | 启动 nudge | | |
| 9 | 容量超限 | | |
| 9 | 路径穿越拒绝 | | |
| 9 | 非 git 项目 | | |
