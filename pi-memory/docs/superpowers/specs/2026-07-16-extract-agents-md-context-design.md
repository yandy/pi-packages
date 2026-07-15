# Extract Agent AGENTS.md Context — Design

> 让 extract agent 能访问 AGENTS.md 内容，使其对 "AGENTS.md rules were followed/violated" 的判断有据可依。

## 问题

extract agent 通过 `agent-runner.ts` 创建 headless sub-agent，`noContextFiles: true`，且 cwd 是 `memoryDir` 而非项目根目录。因此 extract agent 的 system prompt 不含任何 AGENTS.md 内容。

当前 "What to Remember/Skip" 中已包含：
- Remember: `AGENTS.md rules that were violated in this conversation — extract`
- Skip: `AGENTS.md rules that were followed without issue`

但 extract agent 完全不知道 AGENTS.md 写了什么，这两个规则是让模型盲猜。

## 方案

### 数据来源

AGENTS.md 在 pi 的 system prompt 中以 `<project_instructions>` 块注入。存在两层：
- global: `~/.pi/agent-code/AGENTS.md`
- project: cwd 至根路径祖先链上的 `AGENTS.md`

多层都在 system prompt 中出现。选择从 system prompt 提取而非自己读文件，避免依赖 pi 内部 API 或重复路径查找逻辑。

### 数据流

```
before_agent_start                     agent_end
  event.systemPrompt ─► lastSystemPrompt ─► 提取 <project_instructions> 块
                                           ─► agentsMdBlocks[] ─► runExtract()
                                                                ─► buildExtractTask()
                                                                ─► 拼入 task prompt
```

### 注入位置：conversation 之前

```
[system prompt]       ← pi 内置
[task 指令]            ← buildExtractTask 固定文本
[AGENTS.md blocks]     ← 新增，可被 LLM prefix cache 命中
[conversation]         ← 每次变化，cache 断点
```

放在 conversation 之前而非之后：
- extract context 短（~1000 token conversation），位置对注意力影响可忽略
- AGENTS.md 内容稳定，放前面可享受 prefix cache 收益
- 每次 extract 只重算 conversation 段

### 提取逻辑

从 system prompt 中提取所有 `<project_instructions path="...">...</project_instructions>` 块。正则：

```
/<project_instructions\s+path="([^"]+)">\n([\s\S]*?)<\/project_instructions>/g
```

所有匹配块的 `content` 组成 `agentsMdBlocks[]`。

### 提示词调整

"What to Remember" 中 AGENTS.md 规则改为引用式：

```
- AGENTS.md rules that were violated — extract for memory-level reinforcement (refer to the AGENTS.md content above for what rules exist)
```

"What to Skip" 中类似：

```
- AGENTS.md rules that were followed without issue (refer to the AGENTS.md content above)
```

## 改动文件

### `index.ts`

1. 新增模块变量 `let lastSystemPrompt = ""`
2. `before_agent_start` handler 中，捕获 `event.systemPrompt` **原始值**（在 `buildInjection` 追加 MEMORY.md 索引之前），存入 `lastSystemPrompt`
3. `agent_end` handler 中，提取 `<project_instructions>` 块，传入 `runExtract`

### `extract.ts`

1. `RunExtractOpts` 新增 `agentsMdBlocks?: string[]`
2. `buildExtractTask` 新增参数 `agentsMdBlocks: string[]`
3. 在 task prompt 的 conversation 段之前插入 AGENTS.md 块
4. 更新 "What to Remember/Skip" 中 AGENTS.md 规则的措辞

### 测试

1. `extract.test.ts`：验证 `buildExtractTask` 在 AGENTS.md 块存在时的输出格式
2. `index-wiring.test.ts`：验证 system prompt 捕获和传递正确性
