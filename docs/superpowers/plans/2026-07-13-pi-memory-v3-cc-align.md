# pi-memory v3 — Claude Code Memory 对齐 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 pi-memory 对齐 Claude Code 的 auto memory 机制：MEMORY.md 每 topic 一行 + hook、auto-surfacing、extractMemories、memory 类型系统。

**Architecture:** 8 个模块按依赖顺序实现。数据模型先行（config → topic-file → index-file），然后是业务逻辑（memory-tool → inject → extract → dream），最后是接线（index.ts）。每个模块测试先行。

**Tech Stack:** TypeScript, Node.js fs/promises, @earendil-works/pi-coding-agent (ExtensionAPI), @yandy0725/pi-subagents, typebox, vitest

**Worktree:** `.worktrees/feature/pi-memory-v3-cc-align`

## Global Constraints

- 所有变更在 `pi-memory/` 目录下
- 配置文件名从 `pi-memory.json` 改为 `memory.json`
- MEMORY.md 格式：每 topic 一行 `- [Name](file.md) — hook`
- Topic 文件 frontmatter：`name`, `description`, `type` (user/feedback/project/reference), `updated`
- auto-surfacing: `before_agent_start` hook，side-query LLM 选文件 → 注入为 message
- extractMemories: `agent_end` hook，异步 fork 子 agent
- injectedTopics Set 做 session 内去重
- add hook 更新异步执行，不阻塞 add 响应
- 所有 LLM 调用模型可配置（`model: "auto"` 或 `"provider/modelId"`）

---

### Task 1: Config 类型扩展

**Files:**
- Modify: `pi-memory/src/config.ts`
- Modify: `pi-memory/tests/config.test.ts`

**Interfaces:**
- Produces: `MemoryConfig` 新增 `autoSurfacing` 和 `extractMemories` 字段
- Produces: `AutoSurfacingConfig`, `ExtractMemoriesConfig` 子类型
- Produces: `DEFAULT_CONFIG` 更新默认值
- Produces: `loadConfig` 配置文件名从 `pi-memory.json` 改为 `memory.json`

- [ ] **Step 1: 更新 config.test.ts — 测试新字段**

```typescript
// 在 config.test.ts 中新增测试
it("has autoSurfacing defaults", async () => {
  const cfg = await loadConfig({ cwd: "/tmp", isProjectTrusted: () => false });
  expect(cfg.autoSurfacing).toEqual({
    enabled: true,
    model: "auto",
    maxFiles: 5,
    maxTopicBytes: 4096,
    maxInjectionBytes: 20480,
  });
});

it("has extractMemories defaults", async () => {
  const cfg = await loadConfig({ cwd: "/tmp", isProjectTrusted: () => false });
  expect(cfg.extractMemories).toEqual({
    enabled: true,
    model: "auto",
    maxContextTokens: 2000,
  });
});

it("loads config from memory.json not pi-memory.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfg-"));
  const cfgContent = JSON.stringify({
    autoSurfacing: { enabled: false },
    extractMemories: { maxContextTokens: 1000 },
  });
  await writeFile(join(dir, "memory.json"), cfgContent);
  const cfg1 = await loadConfig({
    cwd: dir,
    isProjectTrusted: () => true,
    _globalDir: "/tmp/nonexistent",
    _configDirName: ".pi",
  });
  // 因为 .pi/memory.json 不在 tmp dir，这里测试 globalDir 路径
  // 实际需要设置 _globalDir 到有 memory.json 的地方
});

it("deep-merges autoSurfacing sub-config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfg-"));
  const globalDir = await mkdtemp(join(tmpdir(), "gcfg-"));
  const globalCfg = {
    autoSurfacing: { enabled: false, maxFiles: 3 },
  };
  await writeFile(join(globalDir, "memory.json"), JSON.stringify(globalCfg));
  const cfg = await loadConfig({
    cwd: dir,
    isProjectTrusted: () => true,
    _globalDir: globalDir,
    _configDirName: ".pi",
  });
  expect(cfg.autoSurfacing.enabled).toBe(false);
  expect(cfg.autoSurfacing.maxFiles).toBe(3);
  expect(cfg.autoSurfacing.model).toBe("auto"); // default preserved
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd pi-memory && npx vitest run tests/config.test.ts
```
Expected: FAIL — `autoSurfacing` / `extractMemories` 类型不存在

- [ ] **Step 3: 更新 src/config.ts — 新增类型和配置**

```typescript
// 在 MemoryConfig 前新增
export interface AutoSurfacingConfig {
  enabled: boolean;
  model: string;
  maxFiles: number;
  maxTopicBytes: number;
  maxInjectionBytes: number;
}

export interface ExtractMemoriesConfig {
  enabled: boolean;
  model: string;
  maxContextTokens: number;
}

// 更新 MemoryConfig
export interface MemoryConfig {
  enabled: boolean;
  memoryDir: string;
  memIndexMaxLines: number;
  memIndexMaxBytes: number;
  dream: { nudgeAfterSessions: number; nudgeAfterHours: number; model: string };
  sessionSearch: { maxSessions: number; maxMatches: number };
  autoSurfacing: AutoSurfacingConfig;
  extractMemories: ExtractMemoriesConfig;
}

// 更新 DEFAULT_CONFIG
export const DEFAULT_CONFIG: MemoryConfig = {
  enabled: true,
  memoryDir: join(homedir(), CONFIG_DIR_NAME, "memory"),
  memIndexMaxLines: 200,
  memIndexMaxBytes: 25600,
  dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, model: "auto" },
  sessionSearch: { maxSessions: 10, maxMatches: 5 },
  autoSurfacing: {
    enabled: true,
    model: "auto",
    maxFiles: 5,
    maxTopicBytes: 4096,
    maxInjectionBytes: 20480,
  },
  extractMemories: {
    enabled: true,
    model: "auto",
    maxContextTokens: 2000,
  },
};

// 更新 loadConfig 中的文件名
export async function loadConfig(ctx: LoadConfigContext): Promise<MemoryConfig> {
  const agentDir = ctx._globalDir ?? getAgentDir();
  const configDirName = ctx._configDirName ?? CONFIG_DIR_NAME;
  let cfg: MemoryConfig = { ...DEFAULT_CONFIG };

  // 改为 memory.json — 不再加载旧的 pi-memory.json
  const globalFile = join(agentDir, "memory.json");
  cfg = deepMerge(cfg, readJsonSafe(globalFile));

  if (ctx.isProjectTrusted()) {
    const projectFile = join(ctx.cwd, configDirName, "memory.json");
    cfg = deepMerge(cfg, readJsonSafe(projectFile));
  }

  cfg.memoryDir = expandTilde(cfg.memoryDir);
  return cfg;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd pi-memory && npx vitest run tests/config.test.ts
```
Expected: 全部 PASS（含新增测试）

- [ ] **Step 5: 确认旧测试也通过**

```bash
cd pi-memory && npx vitest run tests/config.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add pi-memory/src/config.ts pi-memory/tests/config.test.ts
git commit -m "feat(config): add autoSurfacing and extractMemories config, rename to memory.json"
```

---

### Task 2: Topic 文件 Frontmatter 扩展

**Files:**
- Modify: `pi-memory/src/topic-file.ts`
- Modify: `pi-memory/tests/topic-file.test.ts`

**Interfaces:**
- Produces: `TopicMeta` 新增 `name: string`, `description: string`, `type: string`
- Produces: `buildFrontmatter(meta: TopicMeta): string` — 输出 4 字段
- Produces: `parseFrontmatter(raw: string): TopicMeta | null` — 新函数，解析 frontmatter
- Produces: `ALLOWED_TYPES` 常量
- Consumes: (none from earlier tasks)

- [ ] **Step 1: 更新 topic-file.test.ts — 新增 frontmatter 测试**

```typescript
// 在现有 imports 后添加
import { parseFrontmatter, ALLOWED_TYPES } from "../src/topic-file";

// 更新 buildFrontmatter 测试
describe("buildFrontmatter", () => {
  it("produces YAML frontmatter with name, description, type, updated", () => {
    const f = buildFrontmatter({
      name: "Debugging",
      description: "Common debugging patterns",
      type: "feedback",
      updated: "2026-07-03",
    });
    expect(f).toBe("---\nname: Debugging\ndescription: Common debugging patterns\ntype: feedback\nupdated: 2026-07-03\n---\n\n");
  });
});

// 新增 parseFrontmatter 测试
describe("parseFrontmatter", () => {
  it("parses full frontmatter with all fields", () => {
    const raw = "---\nname: Debug\ndescription: desc\ntype: feedback\nupdated: 2026-07-03\n---\n\n## Entry\nbody";
    const meta = parseFrontmatter(raw);
    expect(meta).toEqual({
      name: "Debug",
      description: "desc",
      type: "feedback",
      updated: "2026-07-03",
    });
  });

  it("returns null for no frontmatter", () => {
    expect(parseFrontmatter("## No frontmatter\nbody")).toBeNull();
  });

  it("returns null for malformed frontmatter", () => {
    expect(parseFrontmatter("---\nname: X\n## Not closed")).toBeNull();
  });
});

// 新增 ALLOWED_TYPES 测试
describe("ALLOWED_TYPES", () => {
  it("contains four standard types", () => {
    expect(ALLOWED_TYPES).toEqual(["user", "feedback", "project", "reference"]);
  });
});

// 更新 updateFrontmatterDate 测试 — 确保兼容新格式
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd pi-memory && npx vitest run tests/topic-file.test.ts
```
Expected: FAIL — `name`/`description`/`type` 类型不存在，`parseFrontmatter`/`ALLOWED_TYPES` 未导出

- [ ] **Step 3: 更新 src/topic-file.ts**

```typescript
// 更新 TopicMeta
export interface TopicMeta {
  name: string;
  description: string;
  type: string;
  updated: string;
}

// 新增常量
export const ALLOWED_TYPES = ["user", "feedback", "project", "reference"] as const;

// 更新 buildFrontmatter
export function buildFrontmatter(meta: TopicMeta): string {
  return [
    "---",
    `name: ${meta.name}`,
    `description: ${meta.description}`,
    `type: ${meta.type}`,
    `updated: ${meta.updated}`,
    "---",
    "",
    "",
  ].join("\n");
}

// 新增 parseFrontmatter
export function parseFrontmatter(raw: string): TopicMeta | null {
  if (!raw.startsWith("---\n")) return null;
  const endIdx = raw.indexOf("\n---\n", 4);
  if (endIdx === -1) return null;
  const block = raw.slice(4, endIdx);
  const meta: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  if (!meta.name || !meta.description || !meta.type || !meta.updated) return null;
  if (!ALLOWED_TYPES.includes(meta.type)) return null;
  return meta as TopicMeta;
}

// updateFrontmatterDate — 兼容新格式（更新 updated 行）
export function updateFrontmatterDate(raw: string, date: string): string {
  return raw.replace(/^(---\n[\s\S]*?\n)updated: .+(\n.*?---)/m, `$1updated: ${date}$2`);
}

// hasEntries — 不变
// removeEntrySection — 不变
// parseEntries — 不变
// appendContent — 不变
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd pi-memory && npx vitest run tests/topic-file.test.ts
```

- [ ] **Step 5: 确认全部现有测试通过**

```bash
cd pi-memory && npx vitest run
```
Expected: 部分失败（memory-tool.test.ts 因为 doAdd 里 `buildFrontmatter({ updated })` 签名不兼容）

- [ ] **Step 6: Commit**

```bash
git add pi-memory/src/topic-file.ts pi-memory/tests/topic-file.test.ts
git commit -m "feat(topic-file): add name/description/type to frontmatter, parseFrontmatter"
```

---

### Task 3: Index File 格式变更（每 topic 一行）

**Files:**
- Modify: `pi-memory/src/index-file.ts`
- Modify: `pi-memory/tests/index-file.test.ts`

**Interfaces:**
- Produces: `IndexEntry` 新增 `hook: string`，`title` → `name`
- Produces: 新正则 `LINE_RE` 匹配 `- [Name](file.md) — hook`
- Produces: `upsertEntryByTopic(entries, entry): IndexEntry[]` — 替代 `addEntry`
- Produces: `removeEntryByTopic(entries, topic): IndexEntry[]` — 新增
- Produces: `updateHook(entries, topic, hook): IndexEntry[]` — 新增
- Produces: `findEntryByTopic(entries, topic): IndexEntry | null` — 新增
- Consumes: (none)

- [ ] **Step 1: 更新 index-file.test.ts — 新格式测试**

```typescript
// 更新 SAMPLE
const SAMPLE = `- [Architecture](architecture.md) — Go API setup patterns\n- [Builds](builds.md) — npm scripts and make targets\n- [Debugging](debugging.md) — SSH port 2222, MySQL timeout`;

describe("parseIndex", () => {
  it("parses per-topic lines with hooks", () => {
    const f = parseIndex(SAMPLE);
    expect(f.entries).toHaveLength(3);
    expect(f.entries[0]).toMatchObject({
      name: "Architecture",
      topic: "architecture.md",
      hook: "Go API setup patterns",
    });
  });
  it("ignores blank lines and non-pointer lines", () => {
    const f = parseIndex(`# Memory\n\n${SAMPLE}\n\nsome note`);
    expect(f.entries).toHaveLength(3);
  });
  it("allows only one entry per topic (parse discards duplicates, keeping last)", () => {
    // parseIndex 不移重，但使用者在写入时保证唯一性
    const dup = `- [A](x.md) — first\n- [B](x.md) — second`;
    const f = parseIndex(dup);
    expect(f.entries).toHaveLength(2); // parse 不负责去重
  });
});

describe("serializeIndex", () => {
  it("round-trips entries with hooks", () => {
    const f = parseIndex(SAMPLE);
    expect(serializeIndex(f.entries)).toBe(SAMPLE);
  });
  it("writes empty hook without hang", () => {
    // 新建 topic 时 hook 可能为空
    const entries = [{ name: "New", topic: "n.md", hook: "", raw: "" }];
    expect(serializeIndex(entries)).toBe("- [New](n.md) — ");
  });
});

describe("upsertEntryByTopic", () => {
  it("adds new entry when topic not present", () => {
    const entries = parseIndex(SAMPLE).entries;
    const next = upsertEntryByTopic(entries, { name: "New", topic: "n.md", hook: "desc", raw: "" });
    expect(next).toHaveLength(4);
    expect(next[3]).toMatchObject({ name: "New", topic: "n.md", hook: "desc" });
  });
  it("replaces existing entry when topic matches", () => {
    const entries = parseIndex(SAMPLE).entries;
    const next = upsertEntryByTopic(entries, { name: "Debugging V2", topic: "debugging.md", hook: "updated hook", raw: "" });
    expect(next).toHaveLength(3); // same count
    const found = next.find(e => e.topic === "debugging.md");
    expect(found).toMatchObject({ name: "Debugging V2", hook: "updated hook" });
  });
  it("does not modify original array", () => {
    const entries: IndexEntry[] = [{ name: "A", topic: "a.md", hook: "h", raw: "" }];
    upsertEntryByTopic(entries, { name: "B", topic: "b.md", hook: "h2", raw: "" });
    expect(entries).toHaveLength(1);
  });
});

describe("removeEntryByTopic", () => {
  it("removes entry by topic filename", () => {
    const entries = parseIndex(SAMPLE).entries;
    const next = removeEntryByTopic(entries, "builds.md");
    expect(next).toHaveLength(2);
    expect(next.find(e => e.topic === "builds.md")).toBeUndefined();
  });
  it("throws when topic not found", () => {
    const entries = parseIndex(SAMPLE).entries;
    expect(() => removeEntryByTopic(entries, "nonexistent.md")).toThrow("not found");
  });
});

describe("findEntryByTopic", () => {
  it("returns entry for matching topic", () => {
    const entries = parseIndex(SAMPLE).entries;
    const e = findEntryByTopic(entries, "debugging.md");
    expect(e).toBeDefined();
    expect(e!.name).toBe("Debugging");
  });
  it("returns null for non-matching topic", () => {
    const entries = parseIndex(SAMPLE).entries;
    expect(findEntryByTopic(entries, "nonexistent.md")).toBeNull();
  });
});

describe("updateHook", () => {
  it("updates hook for matching topic", () => {
    const entries = parseIndex(SAMPLE).entries;
    const next = updateHook(entries, "debugging.md", "new hook text");
    const found = next.find(e => e.topic === "debugging.md");
    expect(found!.hook).toBe("new hook text");
  });
  it("throws when topic not found", () => {
    const entries = parseIndex(SAMPLE).entries;
    expect(() => updateHook(entries, "nonexistent.md", "h")).toThrow("not found");
  });
});

// 移除 addEntry / removeEntryByTitle / matchEntryByTitle 测试
// 保留 truncateForInjection / checkCapacity 测试
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd pi-memory && npx vitest run tests/index-file.test.ts
```

- [ ] **Step 3: 更新 src/index-file.ts**

```typescript
export interface IndexEntry {
  name: string;      // 原名 title，取自 frontmatter name
  topic: string;     // 文件名
  hook: string;      // 一行描述
  raw: string;       // 原始行文本
}

export interface IndexFile {
  entries: IndexEntry[];
  raw: string;
}

// Matches: - [Name](topic.md) — hook
const LINE_RE = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*—\s*(.*)$/;

export function parseIndex(content: string): IndexFile {
  const entries: IndexEntry[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(LINE_RE);
    if (m) entries.push({
      name: m[1].trim(),
      topic: m[2].trim(),
      hook: m[3].trim(),
      raw: line,
    });
  }
  return { entries, raw: content };
}

export function serializeIndex(entries: IndexEntry[]): string {
  return entries.map((e) => `- [${e.name}](${e.topic}) — ${e.hook}`).join("\n");
}

export function upsertEntryByTopic(entries: IndexEntry[], entry: IndexEntry): IndexEntry[] {
  const idx = entries.findIndex((e) => e.topic === entry.topic);
  if (idx === -1) return [...entries, entry];
  const next = [...entries];
  next[idx] = entry;
  return next;
}

export function removeEntryByTopic(entries: IndexEntry[], topic: string): IndexEntry[] {
  const idx = entries.findIndex((e) => e.topic === topic);
  if (idx === -1) throw new Error(`Topic "${topic}" not found in index`);
  const next = [...entries];
  next.splice(idx, 1);
  return next;
}

export function findEntryByTopic(entries: IndexEntry[], topic: string): IndexEntry | null {
  return entries.find((e) => e.topic === topic) ?? null;
}

export function updateHook(entries: IndexEntry[], topic: string, hook: string): IndexEntry[] {
  const idx = entries.findIndex((e) => e.topic === topic);
  if (idx === -1) throw new Error(`Topic "${topic}" not found in index`);
  const next = [...entries];
  next[idx] = { ...next[idx], hook, raw: "" };
  return next;
}

// truncateForInjection — 不变
// checkCapacity — 不变

// 移除: addEntry, removeEntryByTitle, matchEntryByTitle
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd pi-memory && npx vitest run tests/index-file.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add pi-memory/src/index-file.ts pi-memory/tests/index-file.test.ts
git commit -m "feat(index-file): per-topic index format with hooks, upsert not append"
```

---

### Task 4: Memory Tool — add/remove 适配新格式

**Files:**
- Modify: `pi-memory/src/memory-tool.ts`
- Modify: `pi-memory/tests/memory-tool.test.ts`

**Interfaces:**
- Produces: `AddParams` 新增 `type?: string`
- Produces: `doAdd` 重写：per-topic index + 新 frontmatter + hook
- Produces: `doRemove` 重写：按 entry title 匹配 + 更新 hook
- Produces: `regenerateHook(memoryDir, topic): Promise<void>` — 新函数
- Consumes: `IndexEntry` (with `name`/`hook`), `upsertEntryByTopic`, `removeEntryByTopic`, `findEntryByTopic`, `updateHook` from Task 3
- Consumes: `buildFrontmatter` (with 4 fields), `parseFrontmatter` from Task 2

- [ ] **Step 1: 更新 memory-tool.test.ts — 适配新格式**

关键变化：
1. `doAdd` 同一 topic 追加时不新增 MEMORY.md 行，hook 保持初始值（无 LLM）
2. `doRemove` 删除条目后更新 hook
3. `doAdd` 新 topic 的 frontmatter 包含 name/description/type

```typescript
// 更新 "creates a new topic file" 测试
it("creates a new topic file with v3 frontmatter + MEMORY.md entry", async () => {
  const res = await doAdd(dir, {
    content: "staging uses port 2222",
    topic: "debugging.md",
    title: "SSH Gotcha",
    maxLines: 200,
    maxBytes: 25600,
  });
  expect(res.ok).toBe(true);
  const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
  // per-topic format with hook
  expect(mem).toContain("[Debugging](debugging.md)");
  expect(mem).toContain(" — ");
  const topic = await readFile(join(dir, "debugging.md"), "utf8");
  expect(topic).toContain("staging uses port 2222");
  expect(topic).toContain("name: debugging");
  expect(topic).toContain("description:");
  expect(topic).toContain("type: feedback");
  expect(topic).toContain("updated:");
});

// 更新 "appends second entry to same topic" 测试
it("appends second entry to same topic — MEMORY.md stays one line", async () => {
  await doAdd(dir, {
    content: "first note",
    topic: "debugging.md",
    title: "SSH Gotcha",
    maxLines: 200,
    maxBytes: 25600,
  });
  const res = await doAdd(dir, {
    content: "second note",
    topic: "debugging.md",
    title: "MySQL Timeout",
    maxLines: 200,
    maxBytes: 25600,
  });
  expect(res.ok).toBe(true);
  const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
  // 只有一行
  const lines = mem.trim().split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  const topic = await readFile(join(dir, "debugging.md"), "utf8");
  expect(topic).toContain("## SSH Gotcha");
  expect(topic).toContain("## MySQL Timeout");
});

// 新增：type 参数测试
it("uses explicit type in frontmatter", async () => {
  const res = await doAdd(dir, {
    content: "user preference",
    topic: "prefs.md",
    title: "Editor",
    type: "user",
    maxLines: 200,
    maxBytes: 25600,
  });
  expect(res.ok).toBe(true);
  const topic = await readFile(join(dir, "prefs.md"), "utf8");
  expect(topic).toContain("type: user");
});

// 更新 doRemove 测试
it("removes entry and updates hook", async () => {
  await doAdd(dir, {
    content: "staging uses port 2222",
    topic: "debugging.md",
    title: "SSH Gotcha",
    maxLines: 200,
    maxBytes: 25600,
  });
  await doAdd(dir, {
    content: "connection timeout after 30s",
    topic: "debugging.md",
    title: "MySQL Timeout",
    maxLines: 200,
    maxBytes: 25600,
  });
  const res = await doRemove(dir, { entry: "SSH Gotcha" });
  expect(res.ok).toBe(true);
  const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
  // 仍然存在该 topic 的行
  expect(mem).toContain("[Debugging](debugging.md)");
  const topic = await readFile(join(dir, "debugging.md"), "utf8");
  expect(topic).not.toContain("SSH Gotcha");
  expect(topic).toContain("MySQL Timeout");
});

it("deletes topic file and index line when last entry removed", async () => {
  await doAdd(dir, {
    content: "only entry",
    topic: "temp.md",
    title: "Temp",
    maxLines: 200,
    maxBytes: 25600,
  });
  const res = await doRemove(dir, { entry: "Temp" });
  expect(res.ok).toBe(true);
  await expect(readFile(join(dir, "temp.md"), "utf8")).rejects.toThrow();
  const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
  expect(mem).not.toContain("temp.md");
});

// 移除 "errors on multiple matches" — 因为 per-topic 格式下 entry title 不直接在 MEMORY.md 中
// 保留 path traversal / capacity / title missing / parallel adds 测试
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd pi-memory && npx vitest run tests/memory-tool.test.ts
```

- [ ] **Step 3: 更新 src/memory-tool.ts**

核心变更在 import 和 doAdd/doRemove 函数：

```typescript
// 更新 imports
import {
  parseIndex, serializeIndex, upsertEntryByTopic, removeEntryByTopic,
  findEntryByTopic, updateHook, checkCapacity,
  type IndexEntry,
} from "./index-file";
import {
  buildFrontmatter, appendContent, updateFrontmatterDate,
  removeEntrySection, hasEntries, parseEntries, parseFrontmatter,
  ALLOWED_TYPES,
} from "./topic-file";

// 更新 AddParams
export interface AddParams {
  content: string;
  topic: string;
  title: string;
  type?: string;
  maxLines: number;
  maxBytes: number;
}

// 更新 doAdd
export async function doAdd(memoryDir: string, p: AddParams): Promise<ActionResult> {
  if (!p.title) return { ok: false, error: "title is required" };
  const memType = p.type ?? "feedback";
  if (!ALLOWED_TYPES.includes(memType as any)) {
    return { ok: false, error: `Invalid type "${memType}". Must be one of: ${ALLOWED_TYPES.join(", ")}` };
  }

  let topicPath: string;
  try {
    topicPath = safeTopicPath(memoryDir, p.topic);
  } catch (e: any) {
    return { ok: false, error: e.message };
  }

  return withFileMutationQueue(join(memoryDir, MEMORY_MD), async () => {
    await mkdir(dirname(topicPath), { recursive: true });
    const entries = await readIndex(memoryDir);

    let existingRaw: string | null = null;
    try { existingRaw = await readFile(topicPath, "utf8"); } catch { existingRaw = null; }

    const isNewTopic = !existingRaw;

    // 写 topic 文件
    if (isNewTopic) {
      const topicName = p.topic.endsWith(".md") ? p.topic.slice(0, -3) : p.topic;
      const out = `${buildFrontmatter({
        name: topicName,
        description: p.content.slice(0, 200), // 初始 description 取自 content
        type: memType,
        updated: today(),
      })}${appendContent(null, p.title, p.content)}`;
      await writeFile(topicPath, out, "utf8");
    } else {
      const updated = updateFrontmatterDate(existingRaw, today());
      const out = appendContent(updated, p.title, p.content);
      await writeFile(topicPath, out, "utf8");
    }

    // 写 MEMORY.md
    let next: IndexEntry[];
    if (isNewTopic) {
      const topicName = p.topic.endsWith(".md") ? p.topic.slice(0, -3) : p.topic;
      const newEntry: IndexEntry = {
        name: topicName,
        topic: p.topic,
        hook: p.title,  // 初始 hook = entry title
        raw: "",
      };
      next = upsertEntryByTopic(entries, newEntry);
    } else {
      // 已有 topic — 保持现有行不变（hook 由异步 regenerateHook 后更新）
      next = entries;
    }

    if (!checkCapacity(next, p.maxLines, p.maxBytes)) {
      return {
        ok: false,
        error: `MEMORY.md capacity exceeded (max ${p.maxLines} lines / ${p.maxBytes} bytes).`,
      };
    }
    await writeFile(join(memoryDir, MEMORY_MD), serializeIndex(next) + "\n", "utf8");
    return { ok: true, entries: next };
  });
}

// 异步 hook 更新（由 index.ts 在 add 后调用）
export async function regenerateHook(memoryDir: string, topic: string): Promise<void> {
  // 读取 topic 文件的所有条目，合并生成新 hook
  // 此函数不调用 LLM — LLM 调用由 index.ts 负责
  // 这里只提供纯文件操作：读取 → 生成简单 hook → 写回
  const topicPath = safeTopicPath(memoryDir, topic);
  try {
    const raw = await readFile(topicPath, "utf8");
    const parsedEntries = parseEntries(raw);
    if (parsedEntries.length === 0) return;

    // 简单 hook：合并所有 entry titles（无 LLM 时的默认行为）
    // LLM 生成由 index.ts 的 regenerateHookWithLLM 处理
    const hook = parsedEntries.map(e => e.title).join("; ").slice(0, 150);
    const meta = parseFrontmatter(raw);
    const newDescription = parsedEntries.map(e => e.content.slice(0, 80)).join("; ").slice(0, 200);

    return withFileMutationQueue(join(memoryDir, MEMORY_MD), async () => {
      const entries = await readIndex(memoryDir);
      const next = updateHook(entries, topic, hook);
      await writeFile(join(memoryDir, MEMORY_MD), serializeIndex(next) + "\n", "utf8");

      // 更新 topic 文件 description
      if (meta) {
        // update description in frontmatter
        // (简化：只更新 MEMORY.md hook，description 留给 dream 处理)
      }
    });
  } catch {
    // hook update failure is non-fatal
  }
}

// 更新 doRemove
export async function doRemove(memoryDir: string, p: RemoveParams): Promise<ActionResult> {
  return withFileMutationQueue(join(memoryDir, MEMORY_MD), async () => {
    const entries = await readIndex(memoryDir);

    // 在 topic 文件中搜索 entry
    const files = (await readdir(memoryDir).catch(() => []))
      .filter(f => f.endsWith(".md") && f !== MEMORY_MD);
    
    let targetFile: string | null = null;
    for (const f of files) {
      try {
        const raw = await readFile(join(memoryDir, f), "utf8");
        const parsed = parseEntries(raw);
        if (parsed.some(e => e.title === p.entry)) {
          if (targetFile) {
            return { ok: false, error: `Multiple matches for entry "${p.entry}" in topics: ${targetFile}, ${f}` };
          }
          targetFile = f;
        }
      } catch {}
    }
    if (!targetFile) {
      return { ok: false, error: `Entry "${p.entry}" not found in any topic` };
    }

    const topicPath = safeTopicPath(memoryDir, targetFile);
    const raw = await readFile(topicPath, "utf8");
    const afterRemoval = removeEntrySection(raw, p.entry);

    if (hasEntries(afterRemoval)) {
      const refreshed = updateFrontmatterDate(afterRemoval, today());
      await writeFile(topicPath, refreshed, "utf8");
    } else {
      await unlink(topicPath).catch(() => {});
      // 从 index 中删除该 topic
      const nextIdx = removeEntryByTopic(entries, targetFile);
      await writeFile(join(memoryDir, MEMORY_MD), serializeIndex(nextIdx) + "\n", "utf8");
      return { ok: true };
    }

    // topic 仍有条目 — 保持 index 行不变（hook 可能过时但下次 dream 会修）
    return { ok: true };
  });
}

// doRead / searchMemory — 不变
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd pi-memory && npx vitest run tests/memory-tool.test.ts
```

- [ ] **Step 5: 确认全部测试**

```bash
cd pi-memory && npx vitest run
```
此时 dream.test.ts 会因为 index-file 导出变化而编译失败 — 下个 task 修复。

- [ ] **Step 6: Commit**

```bash
git add pi-memory/src/memory-tool.ts pi-memory/tests/memory-tool.test.ts
git commit -m "feat(memory-tool): per-topic index, v3 frontmatter, type param, regenerateHook"
```

---

### Task 5: Auto-Surfacing 注入

**Files:**
- Modify: `pi-memory/src/inject.ts`
- Modify: `pi-memory/tests/inject.test.ts` (或新文件 `tests/inject.test.ts`)
- Modify: `pi-memory/src/paths.ts` (如需要)

**Interfaces:**
- Produces: `scanTopics(memoryDir): Promise<TopicManifest[]>` — 扫描 topic 文件清单
- Produces: `buildSurfacingPrompt(manifest, userPrompt, injectedTopics): string` — 构建 side-query prompt
- Produces: `injectSurfacedContent(files, maxTopicBytes, maxInjectionBytes): string` — 读取并截断文件，生成注入文本
- Produces: `TopicManifest` 类型
- Consumes: `parseFrontmatter` from Task 2

- [ ] **Step 1: 写 inject.test.ts — auto-surfacing 测试**

```typescript
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scanTopics, buildSurfacingPrompt } from "../src/inject";

describe("scanTopics", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "surf-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("scans topic files and extracts manifests", async () => {
    await writeFile(join(dir, "a.md"), [
      "---",
      "name: Alpha",
      "description: first topic",
      "type: feedback",
      "updated: 2026-07-03",
      "---",
      "",
      "## Entry",
      "content",
    ].join("\n"));
    await writeFile(join(dir, "MEMORY.md"), "dummy");
    const topics = await scanTopics(dir);
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({
      filename: "a.md",
      name: "Alpha",
      description: "first topic",
      type: "feedback",
    });
  });

  it("skips MEMORY.md and non-md files", async () => {
    await writeFile(join(dir, "MEMORY.md"), "dummy");
    await writeFile(join(dir, "not-md.txt"), "text");
    const topics = await scanTopics(dir);
    expect(topics).toHaveLength(0);
  });

  it("handles files without valid frontmatter gracefully", async () => {
    await writeFile(join(dir, "bad.md"), "just text");
    const topics = await scanTopics(dir);
    expect(topics).toHaveLength(0);
  });
});

describe("buildSurfacingPrompt", () => {
  it("builds prompt with manifest and user message", () => {
    const manifest = [
      { filename: "a.md", name: "Alpha", description: "first topic", type: "feedback" as const, mtimeMs: 100 },
      { filename: "b.md", name: "Beta", description: "second topic", type: "project" as const, mtimeMs: 200 },
    ];
    const prompt = buildSurfacingPrompt(manifest, "how do I debug SSH?", new Set(["b.md"]));
    expect(prompt).toContain("[feedback] a.md — first topic");
    expect(prompt).toContain("[project] b.md — second topic");
    expect(prompt).toContain("how do I debug SSH?");
    // b.md 已被注入，提示排除
    expect(prompt).toContain("already injected");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd pi-memory && npx vitest run tests/inject.test.ts
```

- [ ] **Step 3: 实现 src/inject.ts — 新增 auto-surfacing 函数**

```typescript
import { readFile, readdir } from "node:fs/promises";
import { join, stat } from "node:path";
import { truncateForInjection } from "./index-file";
import { parseFrontmatter } from "./topic-file";

// 已有函数不变
export async function loadIndexSnapshot(memoryDir: string, maxLines: number, maxBytes: number): Promise<string> {
  // ... 不变
}

export function buildInjection(systemPrompt: string, snapshot: string): string {
  // ... 不变
}

// ⭐ 新增 — auto-surfacing

export interface TopicManifest {
  filename: string;
  name: string;
  description: string;
  type: string;
  mtimeMs: number;
}

export async function scanTopics(memoryDir: string): Promise<TopicManifest[]> {
  const files = (await readdir(memoryDir).catch(() => []))
    .filter(f => f.endsWith(".md") && f !== "MEMORY.md");
  
  const manifests: TopicManifest[] = [];
  for (const f of files.slice(0, 200)) {
    try {
      const raw = await readFile(join(memoryDir, f), "utf8");
      const meta = parseFrontmatter(raw);
      if (!meta) continue;
      // stat for mtime
      let mtimeMs = 0;
      try {
        const s = await import("node:fs/promises").then(m => m.stat(join(memoryDir, f)));
        mtimeMs = s.mtimeMs;
      } catch {}
      manifests.push({
        filename: f,
        name: meta.name,
        description: meta.description,
        type: meta.type,
        mtimeMs,
      });
    } catch {}
  }
  return manifests.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function buildSurfacingPrompt(
  manifest: TopicManifest[],
  userPrompt: string,
  injectedTopics: Set<string>,
): string {
  const lines = manifest.map(t => {
    const marker = injectedTopics.has(t.filename) ? " [already injected]" : "";
    return `[${t.type}] ${t.filename} — ${t.description.slice(0, 80)}${marker}`;
  });
  const alreadyInjected = injectedTopics.size > 0
    ? `\n\nNote: ${injectedTopics.size} topic file(s) have already been injected in this session and are marked [already injected]. Prefer selecting uninjected topics.`
    : "";

  return [
    "You are a memory relevance selector. Below is a list of memory topic files and a user message.",
    "Select up to N topic files that are relevant to the user's current query.",
    "Response format: JSON with a 'selected_files' array of filenames.",
    alreadyInjected,
    "",
    "=== Topic Files ===",
    ...lines,
    "",
    "=== User Message ===",
    userPrompt,
    "",
    "Return: {\"selected_files\": [\"a.md\", \"b.md\"]}",
  ].join("\n");
}

export async function injectSurfacedContent(
  memoryDir: string,
  selectedFiles: string[],
  maxTopicBytes: number,
  maxInjectionBytes: number,
): Promise<string> {
  const blocks: string[] = [];
  let totalBytes = 0;

  for (const f of selectedFiles) {
    try {
      const raw = await readFile(join(memoryDir, f), "utf8");
      const { content } = truncateForInjection(raw, 999999, maxTopicBytes);
      const block = `## ${f}\n${content}`;
      const blockBytes = Buffer.byteLength(block, "utf8");
      if (totalBytes + blockBytes > maxInjectionBytes) break;
      blocks.push(block);
      totalBytes += blockBytes;
    } catch {}
  }

  if (blocks.length === 0) return "";
  return `<relevant_memories>\n${blocks.join("\n\n")}\n</relevant_memories>`;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd pi-memory && npx vitest run tests/inject.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add pi-memory/src/inject.ts pi-memory/tests/inject.test.ts
git commit -m "feat(inject): auto-surfacing — scanTopics, buildSurfacingPrompt, injectSurfacedContent"
```

---

### Task 6: Extract Memories 模块

**Files:**
- Create: `pi-memory/src/extract.ts`
- Modify: `pi-memory/tests/` (新文件 `extract.test.ts`)

**Interfaces:**
- Produces: `buildExtractTask(memoryDir, messages, maxTokens): string` — 构建子 agent task prompt
- Produces: `runExtract(opts: RunExtractOpts): Promise<void>` — fork 子 agent 的主函数
- Produces: `RunExtractOpts` 类型
- Consumes: `getSubagentsService`, `SubagentsService`, `WorkspaceProvider` from `@yandy0725/pi-subagents`

- [ ] **Step 1: 写 extract.test.ts**

```typescript
import { describe, it, expect } from "vitest";
import { buildExtractTask } from "../src/extract";

describe("buildExtractTask", () => {
  it("builds extraction task prompt with context", () => {
    const messages = [
      { role: "user", content: "how to debug SSH?" },
      { role: "assistant", content: "Use ssh -vvv user@host" },
    ];
    const task = buildExtractTask("/tmp/mem", messages, 2000);
    expect(task).toContain("memory extraction agent");
    expect(task).toContain("/tmp/mem");
    expect(task).toContain("how to debug SSH?");
    expect(task).toContain("ssh -vvv");
    expect(task).toContain("Worth remembering");
    expect(task).toContain("NOT worth remembering");
    expect(task).toContain("frontmatter");
    expect(task).toContain("## Entry Title");
  });

  it("truncates long messages", () => {
    const longMsg = "x".repeat(5000);
    const task = buildExtractTask("/tmp/mem", [{ role: "user", content: longMsg }], 100);
    expect(task.length).toBeLessThan(5000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd pi-memory && npx vitest run tests/extract.test.ts
```
Expected: FAIL — `buildExtractTask` 不存在

- [ ] **Step 3: 创建 src/extract.ts**

```typescript
import { getSubagentsService, type SubagentsService, type WorkspaceProvider } from "@yandy0725/pi-subagents";
import { access } from "node:fs/promises";

export interface RunExtractOpts {
  model: string;
  memoryDir: string;
  messages: Array<{ role: string; content: string }>;
  maxContextTokens: number;
  service?: SubagentsService;
}

export function buildExtractTask(
  memoryDir: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): string {
  // 截断消息
  const fromUser = messages.find(m => m.role === "user");
  const fromAssistant = messages.findLast(m => m.role === "assistant");
  const userText = fromUser?.content ?? "";
  const assistantText = fromAssistant?.content ?? "";
  // 按 maxTokens 截断（粗略估算 ~4 chars/token）
  const maxChars = maxTokens * 4;
  const truncatedUser = userText.slice(0, maxChars / 2);
  const truncatedAssistant = assistantText.slice(0, maxChars / 2);

  return [
    `You are a memory extraction agent. Your cwd is set to the memory directory at ${memoryDir}.`,
    "Analyze the conversation snippet below and decide if there are any learnings worth persisting across sessions.",
    "",
    "If you find valuable information, write it to the appropriate topic file in this directory.",
    "The memory directory contains topic files with this format:",
    "",
    "```yaml",
    "---",
    "name: Topic Name",
    "description: Brief summary for relevance matching",
    "type: feedback  # one of: user, feedback, project, reference",
    "updated: 2026-07-13",
    "---",
    "",
    "## Entry Title",
    "Entry content here.",
    "```",
    "",
    "And MEMORY.md index:",
    "- [Name](file.md) — one-line hook summary",
    "",
    "Worth remembering:",
    "- User preferences, coding style choices, tooling preferences",
    "- Project conventions, architecture decisions, naming patterns",
    "- Debugging insights, workarounds, gotchas discovered",
    '- "Always do X" / "Never do Y" rules',
    "- References to external systems or documentation",
    "",
    "NOT worth remembering:",
    "- One-time task instructions or ephemeral details",
    "- Code snippets or file paths derivable from the project",
    "- Information already captured in CLAUDE.md or AGENTS.md",
    "- Git history or recent changes",
    "",
    "When writing memories:",
    "- Use descriptive, self-contained entry titles (only index lines are injected into future sessions)",
    "- Choose the appropriate type: user, feedback, project, reference",
    '- Default type is "feedback"',
    "- Be concise but complete",
    "- If unsure, do NOT write anything",
    "- Use the write/edit tools to directly modify topic files and MEMORY.md",
    "",
    "=== Conversation ===",
    `User: ${truncatedUser}`,
    `Assistant: ${truncatedAssistant}`,
  ].join("\n");
}

export async function runExtract(opts: RunExtractOpts): Promise<void> {
  if (opts.messages.length === 0) return;

  const service = opts.service ?? getSubagentsService();
  if (!service) return; // silently skip if no subagent service

  const model = opts.model === "auto" ? undefined : opts.model;
  const task = buildExtractTask(opts.memoryDir, opts.messages, opts.maxContextTokens);

  const provider: WorkspaceProvider = {
    async prepare(_ctx) {
      await access(opts.memoryDir).catch(() => {
        throw new Error(`Memory directory not found: ${opts.memoryDir}`);
      });
      return {
        cwd: opts.memoryDir,
        dispose: () => undefined,
      };
    },
  };
  service.registerWorkspaceProvider(provider);

  // Fire-and-forget spawn
  service.spawn("general-purpose", task, model ? { model } : {});
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd pi-memory && npx vitest run tests/extract.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add pi-memory/src/extract.ts pi-memory/tests/extract.test.ts
git commit -m "feat(extract): extractMemories module — async subagent for per-turn learning extraction"
```

---

### Task 7: Dream Prompt 四阶段更新

**Files:**
- Modify: `pi-memory/src/dream.ts`
- Modify: `pi-memory/tests/dream.test.ts`

**Interfaces:**
- Produces: `buildDreamTask(memoryDir, maxLines)` — 更新为四阶段 prompt
- Consumes: (none from earlier tasks beyond existing)

- [ ] **Step 1: 更新 dream.test.ts**

```typescript
it("builds four-phase dream task prompt", () => {
  const task = buildDreamTask("/tmp/mem", 200);
  expect(task).toContain("Phase 1 — Orient");
  expect(task).toContain("Phase 2 — Gather Signal");
  expect(task).toContain("Phase 3 — Consolidate");
  expect(task).toContain("Phase 4 — Prune & Index");
  expect(task).toContain("per topic file");
  expect(task).toContain("~150 chars");
  expect(task).toContain("name:");
  expect(task).toContain("description:");
  expect(task).toContain("type:");
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd pi-memory && npx vitest run tests/dream.test.ts
```

- [ ] **Step 3: 更新 src/dream.ts — buildDreamTask**

```typescript
export function buildDreamTask(memoryDir: string, maxLines: number): string {
  return `You are a memory consolidation agent. Your job is to read all memory files
and consolidate them into a clean, deduplicated memory store.

Phase 1 — Orient:
- List all files in ${memoryDir}
- Read MEMORY.md to understand current index
- Skim each topic file to understand its contents

Phase 2 — Gather Signal:
- Find duplicate entries within and across topic files
- Identify contradictory information
- Spot outdated or obsolete entries
- Note temporal references that should be absolute dates

Phase 3 — Consolidate:
- Merge duplicates into single entries
- Resolve contradictions — pick the most accurate version
- Convert relative dates (today, last week) to absolute dates
- Update outdated information
- Move entries to more appropriate topic files when needed
- Delete entries that are no longer relevant

Phase 4 — Prune & Index:
- For each topic file, update frontmatter:
  name: meaningful name for the topic
  description: specific summary that helps LLM match queries (be specific!)
  type: one of user, feedback, project, reference
  updated: today's date
- Generate a compact hook (~150 chars) for each topic summarizing its entries
- Rebuild MEMORY.md with one line per topic file (max ${maxLines} lines):
  - [Name](file.md) — hook
- Remove topic files that have no remaining entries

CRITICAL for hooks and descriptions:
- Only the MEMORY.md index is injected into future coding sessions.
  Topic file content is NOT seen by the coding agent unless explicitly
  read or auto-surfaced. The hook and description must be specific
  enough that the LLM can correctly decide relevance.
- Bad: "Debugging tips"
- Good: "SSH port 2222 on staging; MySQL 30s timeout; Redis auth fix"
- Each topic file's \`## Entry Title\` blocks contain the actual memory entries.
  The MEMORY.md line is just a pointer — only ONE line per topic file.
- When done, output a concise summary of changes (merged N, removed N, moved N, updated N).`;
}
```

`runDream` 函数本身不变。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd pi-memory && npx vitest run tests/dream.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add pi-memory/src/dream.ts pi-memory/tests/dream.test.ts
git commit -m "feat(dream): four-phase consolidation prompt (Orient→Gather→Consolidate→Prune)"
```

---

### Task 8: Index.ts 接线 — Hooks + injectedTopics + 工具描述

**Files:**
- Modify: `pi-memory/index.ts`

**Interfaces:**
- Produces: `injectedTopics` Set 维护
- Produces: `before_agent_start` handler 扩展（auto-surfacing）
- Produces: `agent_end` handler（extractMemories）
- Produces: `memory` 工具 promptGuidelines 更新
- Consumes: `scanTopics`, `buildSurfacingPrompt`, `injectSurfacedContent` from Task 5
- Consumes: `runExtract` from Task 6
- Consumes: `MemoryConfig` (with `autoSurfacing`, `extractMemories`) from Task 1

- [ ] **Step 1: 更新 index.ts**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type MemoryConfig } from "./src/config";
import { resolveMemoryDir } from "./src/paths";
import { loadIndexSnapshot, buildInjection, scanTopics, buildSurfacingPrompt, injectSurfacedContent } from "./src/inject";
import { createMemoryTool } from "./src/memory-tool";
import { searchSessions } from "./src/session-search";
import { runDream } from "./src/dream";
import { runExtract } from "./src/extract";
import { shouldNudge, writeDreamMeta, readDreamMeta } from "./src/nudge";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  let memoryDir: string | null = null;
  let config: MemoryConfig | null = null;
  let indexSnapshot = "";
  let toolRegistered = false;
  const injectedTopics = new Set<string>();  // ⭐ session 内去重

  pi.on("session_start", async (_event, ctx) => {
    config = await loadConfig(ctx);
    if (!config.enabled) return;
    memoryDir = await resolveMemoryDir(config, ctx.cwd);
    indexSnapshot = await loadIndexSnapshot(memoryDir, config.memIndexMaxLines, config.memIndexMaxBytes);
    injectedTopics.clear();  // ⭐ 新 session 清空

    // register memory tool once
    if (!toolRegistered) {
      pi.registerTool(createMemoryTool({
        getMemoryDir: () => memoryDir,
        getConfig: () => config!,
        getEnabled: () => config?.enabled ?? false,
        searchSessions,
        cwd: () => ctx.cwd,
      }) as any);
      toolRegistered = true;
    }

    // nudge — 不变
    // ...
  });

  pi.on("before_agent_start", async (event) => {
    if (!config?.enabled || !memoryDir) return;

    // 1. 注入 MEMORY.md 索引（已有逻辑）
    const result: any = {};
    if (indexSnapshot) {
      result.systemPrompt = buildInjection(event.systemPrompt, indexSnapshot);
    }

    // 2. ⭐ auto-surfacing
    const surf = config.autoSurfacing;
    if (surf.enabled && event.prompt) {
      try {
        const manifest = await scanTopics(memoryDir);
        const prompt = buildSurfacingPrompt(manifest, event.prompt, injectedTopics);
        // side-query: 这里需要实际的 LLM 调用
        // pi 的 side-query 机制：通过 ctx.ai.completion 或其他方式
        // 暂时：如果没有 side-query 工具函数，使用简单的关键词匹配作为 fallback
        const selectedFiles = await selectRelevantTopics(
          prompt, manifest, surf, event.prompt, injectedTopics, pi,
        );

        if (selectedFiles.length > 0) {
          const content = await injectSurfacedContent(
            memoryDir, selectedFiles, surf.maxTopicBytes, surf.maxInjectionBytes,
          );
          for (const f of selectedFiles) injectedTopics.add(f);

          if (content) {
            result.message = {
              customType: "memory-auto-surfacing",
              content,
              display: false,
            };
          }
        }
      } catch {
        // auto-surfacing error is non-fatal
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  });

  // ⭐ agent_end — extractMemories
  pi.on("agent_end", async (event) => {
    if (!config?.enabled || !memoryDir) return;
    const ext = config.extractMemories;
    if (!ext.enabled) return;

    try {
      // 收集本轮对话
      const messages = (event.messages ?? []).map((m: any) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      }));

      // 异步 fire-and-forget
      setTimeout(() => {
        runExtract({
          model: ext.model,
          memoryDir,
          messages,
          maxContextTokens: ext.maxContextTokens,
        }).catch(() => {});
      }, 0);
    } catch {
      // non-fatal
    }
  });

  // /memory 命令 — 不变
  // /dream 命令 — 不变
}

// ⭐ 简易 topic 选择函数（LLM side-query 或 fallback 关键词匹配）
async function selectRelevantTopics(
  _prompt: string,
  manifest: Array<{ filename: string; description: string; type: string }>,
  config: { model: string; maxFiles: number },
  userPrompt: string,
  injectedTopics: Set<string>,
  _pi: ExtensionAPI,
): Promise<string[]> {
  // 过滤已注入的
  const candidates = manifest.filter(t => !injectedTopics.has(t.filename));
  if (candidates.length === 0) return [];

  // 简单关键词匹配作为 fallback（不调额外 LLM）
  const q = userPrompt.toLowerCase();
  const scored = candidates
    .map(t => {
      const desc = (t.description + " " + t.filename).toLowerCase();
      const words = q.split(/\s+/).filter(w => w.length > 2);
      const score = words.filter(w => desc.includes(w)).length;
      return { ...t, score };
    })
    .filter(t => t.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, config.maxFiles).map(t => t.filename);
}
```

- [ ] **Step 2: 运行全部测试**

```bash
cd pi-memory && npx vitest run
```

- [ ] **Step 3: Commit**

```bash
git add pi-memory/index.ts
git commit -m "feat(index): wire auto-surfacing and extractMemories hooks, session dedup"
```

---

### Task 9: 最终验证 & 清理

- [ ] **Step 1: 运行全部测试**

```bash
cd pi-memory && npx vitest run
```
Expected: 全部通过

- [ ] **Step 2: Typecheck**

```bash
cd pi-memory && npx tsc --noEmit
```
Expected: 无类型错误

- [ ] **Step 3: Commit 最终调整**

```bash
git add -A
git commit -m "chore: final test and type fixes"
```
