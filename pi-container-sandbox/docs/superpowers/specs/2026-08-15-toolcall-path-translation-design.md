# 第三方工具 tool_call 路径翻译设计

> 状态：已确认（2026-08-15）

## 背景

`pi-container-sandbox` 只把内置工具 `bash` / `read` / `write` / `edit` 路由进容器，
项目 cwd 以读写方式 bind-mount 到 `/workspace`。agent 在 `before_agent_start` 阶段
被告知 cwd 为 `/workspace`，因此天然输出 `/workspace/...` 绝对容器路径。

第三方扩展工具（如 `pi-vision-tools` 的 `describe_image`）运行在**宿主机**上
（pi 官方文档 containerization.md 明确：tool-routing 扩展只路由自己代理的工具，
其他自定义扩展工具仍在宿主机运行）。当 agent 把 `/workspace/foo.png` 传给这类工具时，
宿主机 `readFile("/workspace/foo.png")` 找不到文件（宿主机上没有 `/workspace`），工具失败。

## 目标

让宿主机上运行的第三方工具（以及宿主机内置工具 `find` / `grep` / `ls`）能正确读取
agent 给出的 `/workspace` 绝对路径，无需第三方工具做任何改动。

## 方案：`tool_call` 事件通用路径翻译

pi 的 `tool_call` 事件中 `event.input` 可变，且「对 `event.input` 的修改会作用到真实工具执行」，
这是官方为工具调用拦截/改写预留的机制（`pi-permission-system` 已有先例）。

sandbox 订阅 `tool_call`，对**非自己路由**的工具，把其输入参数中的 `/workspace` 路径
原地翻译为宿主机路径。

## 设计决策

| 决策 | 结论 |
|------|------|
| 拦截时机 | `tool_call` 事件（`event.input` 原地 mutate） |
| 翻译范围 | **仅 `/workspace`**（项目 cwd 挂载）。不处理 `/skills`、不处理用户 mount |
| 跳过集合 | `{ "bash", "read", "write", "edit" }` —— sandbox 自己路由的工具，内部已做 `hostToContainer` |
| 配置开关 | **无**，始终开启（YAGNI，需要时再补） |
| 映射失败 | 不抛错，原样返回（防御式） |
| 遍历方式 | 递归遍历对象/数组，只替换「字符串值」中等于 `/workspace` 或以 `/workspace/` 开头的值 |
| 相对路径/自由文本 | 一律不动（只匹配 `/workspace` 前缀，天然不误翻） |

## 组件

### `src/path-translation.ts`（新增，单一职责，纯函数可测）

```ts
import { resolve as resolvePath } from "node:path";
import { CONTAINER_ROOT } from "./paths";

export const SANDBOX_ROUTED_TOOLS = new Set(["bash", "read", "write", "edit"]);

// /workspace → hostCwd；/workspace/xxx → hostCwd/xxx；其余原样返回
export function workspacePathToHost(path: string, hostCwd: string): string {
	if (path === CONTAINER_ROOT) return hostCwd;
	if (path.startsWith(`${CONTAINER_ROOT}/`)) {
		return resolvePath(hostCwd, path.slice(CONTAINER_ROOT.length + 1));
	}
	return path;
}

// 递归遍历 input，原地把字符串值中的 /workspace 路径替换为宿主机路径
export function translateToolCallPaths(input: unknown, hostCwd: string): void {
	if (Array.isArray(input)) {
		for (let i = 0; i < input.length; i++) {
			const v = input[i];
			if (typeof v === "string") input[i] = workspacePathToHost(v, hostCwd);
			else translateToolCallPaths(v, hostCwd);
		}
		return;
	}
	if (input && typeof input === "object") {
		for (const key of Object.keys(input)) {
			const v = (input as Record<string, unknown>)[key];
			if (typeof v === "string") (input as Record<string, unknown>)[key] = workspacePathToHost(v, hostCwd);
			else translateToolCallPaths(v, hostCwd);
		}
	}
}
```

说明：字符串是叶子，直接写回父槽位（数组下标或对象键）；number/boolean/null 等原始值 no-op。

### `index.ts`（改）

```ts
import { SANDBOX_ROUTED_TOOLS, translateToolCallPaths } from "./src/path-translation";

// 在 registerTool 之后新增：
pi.on("tool_call", (event) => {
	const sbx = getSbx();
	if (!sbx) return;
	if (SANDBOX_ROUTED_TOOLS.has(event.toolName)) return;
	translateToolCallPaths(event.input, sbx.hostCwd);
});
```

## 数据流

```
agent 调 describe_image(image_path="/workspace/foo.png")
  │
  ▼ tool_call（sandbox handler）
  │   非路由工具 → translateToolCallPaths(input, hostCwd)
  │   image_path: "/workspace/foo.png" → "/home/user/proj/foo.png"
  ▼
pi-vision-tools execute() 拿到翻译后的 image_path → readFile 成功
```

`read`/`write`/`edit`/`bash` 被跳过（内部已翻译）；`find`/`grep`/`ls` 与所有第三方工具自动受益。

## 错误处理与边界

- `workspacePathToHost` 只对 `/workspace` 前缀做纯字符串替换，永不抛错。
- `translateToolCallPaths` 对 null / undefined / number / boolean 等非对象输入 no-op。
- 已知局限：若第三方工具自身是「容器感知」并期望收到容器路径，会被误翻 —— 此类工具应走
  协作式共享函数（方案 C，本次不做）。

## 测试

`tests/paths.test.ts`（或新增 `tests/path-translation.test.ts`）覆盖：

1. `workspacePathToHost`：
   - `/workspace` → hostCwd
   - `/workspace/foo.png` → hostCwd/foo.png
   - `/workspace/a/b/c` → hostCwd/a/b/c
   - 相对路径 `foo.png`、宿主绝对路径 `/home/x/a.png`、自由文本 `describe /workspace/foo` 原样返回
2. `translateToolCallPaths`：
   - 顶层字符串字段翻译
   - 嵌套对象、数组内字符串翻译
   - 相对路径 / 自由文本 / 非对象值不动
   - null / undefined / number 输入 no-op 不抛错
3. 跳过逻辑：`SANDBOX_ROUTED_TOOLS` 包含 `bash`/`read`/`write`/`edit`（可选，直接断言 Set 内容）

## 变更文件

| 文件 | 变更 |
|------|------|
| `src/path-translation.ts` | 新增：`workspacePathToHost`、`translateToolCallPaths`、`SANDBOX_ROUTED_TOOLS` |
| `index.ts` | 新增 `tool_call` 订阅 |
| `tests/path-translation.test.ts` | 新增单测 |

## 不变的部分

- `paths.ts` 的 `hostToContainer` / `containerToHost` / `isContainerPath` 等均不改。
- `read`/`write`/`edit`/`bash` 的工具路由逻辑不变。
- `/skills` 与用户 mount 的翻译行为不变（本方案不触及）。
- 配置结构（`sandbox.json`）不变。
