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

### 注入位置：conversation 之前，Remember/Skip 之后

```
[system prompt]          ← pi 内置
[task 指令]               ← 含 ## What to Remember / ## What to Skip
[AGENTS.md blocks]        ← 新增，可被 LLM prefix cache 命中
[conversation]            ← 每次变化，cache 断点
```

AGENTS.md 放在 Remember/Skip 规则之后、conversation 之前：
- 模型先读到判定规则，再读到 AGENTS.md 参考内容，最后读 conversation 做判断——流程自然
- extract context 短（~1000 token conversation），位置对注意力影响可忽略
- AGENTS.md 内容稳定，放 conversation 之前可享受 prefix cache 收益

### 提取逻辑

从 system prompt 中提取所有 `<project_instructions path="...">...</project_instructions>` 块。正则：

```
/<project_instructions\s+path="([^"]+)">\n([\s\S]*?)<\/project_instructions>/g
```

所有匹配块的 `content` 组成 `agentsMdBlocks[]`。

### 提示词调整

"What to Remember" 中 AGENTS.md 规则改为引用式：

```
- AGENTS.md rules that were violated — extract for memory-level reinforcement (refer to the AGENTS.md content below)
```

"What to Skip" 中类似：

```
- AGENTS.md rules that were followed without issue (refer to the AGENTS.md content below)
```

## 改动文件

### `index.ts`

**1. 新增模块变量：**

```ts
let lastSystemPrompt = "";
```

**2. `before_agent_start` handler：** 在 `buildInjection(...)` 调用之前捕获原始 system prompt：

```ts
lastSystemPrompt = event.systemPrompt;
```

注意：必须在 `buildInjection` 之前获取，因为 `buildInjection` 会在尾部追加 MEMORY.md 索引，破坏干净的 `<project_instructions>` 提取。

**3. `agent_end` handler：** 新增辅助函数 `extractAgentsMdBlocks`，从 system prompt 中提取所有 `<project_instructions>` 块，传入 `runExtract`：

```ts
function extractAgentsMdBlocks(systemPrompt: string): string[] {
  const blocks: string[] = [];
  const re = /<project_instructions\s+path="([^"]+)">\n([\s\S]*?)<\/project_instructions>/g;
  let match;
  while ((match = re.exec(systemPrompt)) !== null) {
    // match[0] 是整个标签块，包含 path 信息
    blocks.push(match[0]);
  }
  return blocks;
}
```

调用处：
```ts
runExtract({
  ...
  agentsMdBlocks: extractAgentsMdBlocks(lastSystemPrompt),
});
```

### `extract.ts`

**1. `RunExtractOpts` 新增字段：**

```ts
// 新增
agentsMdBlocks?: string[];
```

**2. `buildExtractTask` 签名变更 + 参数传递：**

```ts
// before
export function buildExtractTask(
  memoryDir: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): string

// after
export function buildExtractTask(
  memoryDir: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  agentsMdBlocks: string[],  // 新增
): string
```

**3. `runExtract` 调用处传入 `opts.agentsMdBlocks ?? []`**

**4. Task prompt 中插入 AGENTS.md 块**，位于 `"## Memory Entry Guidelines"` 之后、`"=== Conversation ==="` 之前：

```ts
// 在 "=== Conversation ===" 之前插入
...(agentsMdBlocks.length > 0
  ? ["", "## AGENTS.md Rules", ...agentsMdBlocks]
  : []),
"=== Conversation ===",
```

每个 `agentsMdBlocks[i]` 是单个 `<project_instructions path="...">\n...\n</project_instructions>` 的完整内容，保留原始 path 信息。

**5. 提示词措辞更新：**

```
// Remember
- before: "AGENTS.md rules that were violated in this conversation — extract for memory-level reinforcement"
- after:  "AGENTS.md rules that were violated — extract for memory-level reinforcement (refer to the AGENTS.md content below)"

// Skip
- before: "AGENTS.md rules that were followed without issue"
- after:  "AGENTS.md rules that were followed without issue (refer to the AGENTS.md content below)"
```

### 测试

1. `extract.test.ts`：验证 `buildExtractTask` 在 AGENTS.md 块存在时的输出格式
2. `index-wiring.test.ts`：验证 system prompt 捕获和传递正确性
