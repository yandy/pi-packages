# 显示完整 provider-id/model-id 作为模型名

日期: 2026-06-28

## 问题

当前 `resolveModelName` 函数（`src/tools/spawn-config.ts`）只产生短显示名：

```typescript
export function resolveModelName(model: { id?: string; name?: string } | undefined): string | undefined {
    if (!model) return undefined;
    const raw = model.name ?? model.id;
    if (!raw) return undefined;
    return raw.replace(/^Claude\s+/i, "").toLowerCase();
}
// 输入: { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }
// 输出: "sonnet 4.5"
```

这有两个问题：
1. 显示名太短，无法区分 provider（如 anthropic vs openai 都有 sonnet 命名的模型）
2. 逻辑中硬编码了 `replace(/^Claude\s+/i, "")` — 只对 Anthropic 模型有效

Pi AI 的 `Model` 接口具备 `provider` 字段，可用于构造完整名。

## 设计

### 核心改动：`resolveModelName`

```typescript
export function resolveModelName(
  model: { id?: string; name?: string; provider?: string } | undefined
): string | undefined {
    if (!model) return undefined;
    // 优先：provider/id 完整格式
    if (model.provider && model.id) return `${model.provider}/${model.id}`;
    // fallback：name 或 id 原始值，不做任何转换
    return model.name ?? model.id ?? undefined;
}
```

### 输出示例

| 输入 | 输出 |
|------|------|
| `{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }` | `"anthropic/claude-sonnet-4-5"` |
| `{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }` | `"openai/gpt-4o"` |
| `{ id: "claude-sonnet", name: "Claude Sonnet" }` (无 provider) | `"Claude Sonnet"` (fallback) |
| `undefined` | `undefined` |

### 类型变更

**`ModelInfo`** — `parentModel` 增加 `provider?`：

```typescript
export interface ModelInfo {
    parentModel: { id: string; name?: string; provider?: string } | undefined;
    modelRegistry: unknown;
}
```

### 受影响的文件

| 文件 | 变更 |
|------|------|
| `src/tools/spawn-config.ts` | `resolveModelName` 签名和逻辑；`ModelInfo` 接口 |
| `src/runtime.ts` | `getModelInfo()` — 透传 `provider`（类型已自动包含 `provider`） |
| `src/service/service-adapter.ts` | 移除 `as { id?; name? }` 窄类型断言 |
| `tests/tools/spawn-config.test.ts` | `makeModelInfo` 增加 `provider`；期望值更新（如 `"sonnet"` → `"anthropic/claude-sonnet"`） |
| 其他测试透传 `modelName` | 仅用于验证管道的测试（如 widget、display、result-renderer）保持不变 |

### 向后兼容

- 当 Model 对象缺少 `provider` 时回退至 `name ?? id` 原始值 — 不中断
- 下游展示层（widget、通知、导航器）仅使用字符串，不关心格式

### 不可修改

- `model-resolver.ts` 中的 model 解析逻辑
- 展示层（`widget-renderer.ts`、`display.ts`、`result-renderer.ts`）— 仅透传 `modelName`
