# pi-todo 设计规格

## 定位

极简风格 pi todo 扩展包。控制工具数量和提示词注入，让用户直观查看 todo 状态。
定位在"轻量但实用"：1 个工具 + 3 个源文件，功能平衡。

## 数据模型

```ts
interface TodoItem {
  id: string;          // uuid
  title: string;       // 任务标题
  status: "pending" | "in_progress" | "done";
  blockedBy?: string[]; // 依赖的任务 ID 列表（可选）
}

interface TodoList {
  items: TodoItem[];
}
```

- 3 状态：`pending` → `in_progress` → `done`
- 单向依赖：`blockedBy` 字段引用前置任务
- 不引入优先级，保持轻量
- 使用 uuid 生成唯一 ID

## 文件结构

```
pi-todo/
├── index.ts          # 入口：注册工具 + widget + 生命周期钩子
├── src/
│   ├── todo-store.ts # Todo 数据模型 + 状态管理
│   └── widget.ts     # Widget 渲染
├── tests/
│   └── todo.test.ts
├── package.json
├── tsconfig.json
├── README.md
├── RELEASE.md
└── vitest.config.ts
```

总计 3 个源文件（index + 2 src 模块）。

## 工具设计：`todo`

唯一工具，通过 `action` 参数区分操作：

### action: "set"
- **用途**：规划阶段一次性列出所有任务（全量替换）
- **参数**：`{ action: "set", items: TodoItem[] }`
- **行为**：替换当前 todo 列表

### action: "update"
- **用途**：执行阶段更新单个任务
- **参数**：`{ action: "update", id: string, status?: "pending" | "in_progress" | "done", title?: string, blockedBy?: string[] }`
- **行为**：按 ID 查找任务，更新指定字段。避免全量替换的出错风险。

### action: "list"
- **用途**：让 LLM 随时查看当前进度
- **参数**：`{ action: "list" }`
- **行为**：返回当前 todo 列表的文本表示

### 渲染

- `renderCall`: 显示 action 名称 + 关键参数
- `renderResult`: 对于 set/list 显示列表摘要，update 显示变更内容

## Widget

### 位置与样式
- 编辑器上方紧凑条
- 单行显示所有 todo 项

### 图标
- `○` → pending
- `◉` → in_progress  
- `✓` → done（带删除线样式）
- `🔒` → blocked（blockedBy 中有未完成项）

### 行为
- 全部 done 时自动隐藏 widget
- 超出单行时截断并显示 "..."
- 无任务时 widget 不渲染任何内容（不占空间）

## 持久化

采用 pi 官方推荐的状态管理方式——将完整快照存入 tool result `details`，而非 `appendEntry`。原因：这种方式天然支持分支（branch-safe），`/fork` 或 `/clone` 后 todo 状态自动还原到该历史点。

- 每次 `set` / `update` 执行时，将当前完整列表写入返回值的 `details.todos`
- `session_start` 和 `session_tree` 事件触发重建：扫描 `ctx.sessionManager.getBranch()` 中所有 `todo` 工具的 toolResult，取最后一条的 `details` 作为当前状态
- Session resume 时同样走 `session_start` 重建路径，todo 状态可见
- 依赖校验：set 时校验 blockedBy 引用的 ID 存在、无自依赖、无循环依赖，校验失败返回错误
- 仅在当前 session 内有效，不跨 session 共享

## 提示词注入

极简注入，直接在工具定义上声明 `promptSnippet` 与 `promptGuidelines`，由 pi 自动注入到系统提示词的 `Available tools` 与 `Guidelines` 区块。无需额外 `before_agent_start` 事件钩子，零胶水代码。

- `promptSnippet`: `Track tasks with a todo list.`
- `promptGuidelines`:
  - `Use todo to plan multi-step work: action "set" lists all tasks up front.`
  - `Use todo action "update" to mark tasks in_progress/done as you complete them.`

## 生命周期

- **重建（session_start / session_tree）**: 扫描 getBranch() 重建内存状态，刷新 widget
- **工具执行**: 更新内存状态，写入返回值 details（持久化），刷新 widget
- **Widget 生命周期**: 跟随 session，全部 done 或无任务时自动隐藏

## 工程质量

- TypeScript 严格模式
- vitest 测试（状态逻辑 + 边界情况）
- biome lint/format
- 发布到 npm：`@yandy0725/pi-todo`

## 参考借鉴

| 来源 | 借鉴点 |
|------|--------|
| rpiv-todo | blockedBy 依赖追踪、增量操作设计、overlay widget 生命周期 |
| pi-todotools | 提示词注入模式 |
| pi-tasks | 工具描述中的简洁工作流指引 |
