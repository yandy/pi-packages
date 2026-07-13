# pi-memory v3 手动测试

> 在真实 pi 会话中验证 v3 核心功能。在一个干净的测试项目中执行。

## 准备

```bash
mkdir -p /tmp/mem-v3-test && cd /tmp/mem-v3-test && git init
pi -e /path/to/pi-packages/pi-memory    # 临时加载
```

---

## 测试 1: MEMORY.md per-topic 一行 + hook

```
记住这个项目的测试用 npm test 命令
```

**验证**：查看 `~/.pi/memory/<hash>/MEMORY.md`，应该只有一行：

```
- [builds](builds.md) — npm test
```

再记一条同一 topic 的：

```
记住：测试前需要先跑 npm run build
```

**验证**：MEMORY.md 仍只有一行，hook 更新为包含两条摘要（如 `— npm test；npm run build`）。

```
- [builds](builds.md) — npm test; npm run build
```

---

## 测试 2: memory type 参数

```
记住我的偏好：我喜欢回复用中文，类型是 user
```

**验证**：查看 topic 文件 frontmatter，`type: user`。

```
记住：这个项目 merge 到 main 之前必须先 rebase，类型 project
```

**验证**：frontmatter 中 `type: project`。

不指定 type 时默认 `feedback`：

```
记住：staging 的 SSH 端口是 2222
```

**验证**：frontmatter 中 `type: feedback`。

---

## 测试 3: 配置文件名变更

**验证**：确认 `~/.pi/agent/` 下有 `memory.json`（不再读 `pi-memory.json`）。

在 `memory.json` 中设置 `"enabled": false`，重启 pi，验证 agent 无法调 memory 工具。

---

## 测试 4: 跨会话 snapshot + auto-surfacing

1. 记 3-4 条不同主题的记忆（debugging、builds、preferences）
2. 退出 pi
3. 重进，直接问：

```
这个项目测试用啥命令？SSH 端口是多少？
```

**预期**：agent 能正确回答。

**进阶**：查看系统提示词（`/memory` 后再问"你的 system prompt 里有啥"），确认：
- MEMORY.md 索引在 system prompt 中
- <relevant_memories> 标签仅在首次注入对应 topic 时出现

---

## 测试 5: extractMemories（自动提取）

1. 在一个有记忆的项目里，和 agent 聊一些具体偏好：

```
我喜欢用 pnpm 而不是 npm；项目架构是 monorepo
```

2. 不要手动说"记住"，直接退出 pi
3. 检查 topic 文件是否有新条目被自动写入

**验证**：agent 的某轮 agent_end 触发了 extractMemories，`/memory` 可以看到新增的 topic 或条目。

---

## 测试 6: Dream 四阶段

1. 记 5-8 条记忆，故意重复/矛盾（如两次不同的端口号）
2. `/dream` → 确认
3. **验证**：整理后的 MEMORY.md 每 topic 一行，hook 准确；矛盾被解决

---

## 结果

| # | 场景 | ✓/✗ |
|---|------|-----|
| 1 | MEMORY.md 每 topic 一行 + hook 更新 | |
| 2 | type 参数 (user/project/feedback) | |
| 3 | memory.json 配置 | |
| 4 | 跨会话注入 + auto-surfacing | |
| 5 | extractMemories 自动提取 | |
| 6 | Dream 四阶段整理 | |
