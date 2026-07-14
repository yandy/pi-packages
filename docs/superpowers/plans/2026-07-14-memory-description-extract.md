# Fix Description & Extract Tool Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix stale `description` in topic file frontmatter and migrate extract agent from raw file I/O to `memory` tools.

**Architecture:** `agent-runner.ts` becomes a generic headless runner accepting `tools` (built-in names) + `customTools` (ToolDefinition objects). Extract gets memory tools; side-query gets zero tools; dream keeps file I/O. Description and MEMORY.md hook are regenerated together from all entry titles after every add/remove.

**Tech Stack:** TypeScript, Vitest, pi-coding-agent SDK

## Global Constraints

- Extract `enabled`, `thinkLevel`, `maxContextTokens` config fields remain unchanged
- Dream agent keeps `["read", "write", "edit", "ls"]` (default behavior)
- No changes to `MEMORY.md` format or hook generation logic
- `tools` default must override SDK default (`read/bash/edit/write`) with `FILE_IO_TOOLS` (`read/write/edit/ls`)

---

### Task 1: Rename `MEMORY_AGENT_TOOLS` → `FILE_IO_TOOLS`

**Files:**
- Modify: `pi-memory/src/agent-config.ts`
- Modify: `pi-memory/src/agent-runner.ts:1-2` (import)
- Modify: `pi-memory/tests/agent-runner.test.ts:59-61` (assertion)

**Interfaces:**
- Produces: `export const FILE_IO_TOOLS = ["read", "write", "edit", "ls"] as const;`

- [ ] **Step 1: Rename in agent-config.ts**

In `pi-memory/src/agent-config.ts`, replace the entire file:

```ts
/** Default built-in tools for headless agents (file I/O only, no bash). */
export const FILE_IO_TOOLS = ["read", "write", "edit", "ls"] as const;
```

- [ ] **Step 2: Update import in agent-runner.ts**

In `pi-memory/src/agent-runner.ts`, change the import line:

```ts
// Before
import { MEMORY_AGENT_TOOLS } from "./agent-config";

// After
import { FILE_IO_TOOLS } from "./agent-config";
```

And update the usage inside `createAgentSession`:

```ts
// Before
tools: [...MEMORY_AGENT_TOOLS],

// After
tools: [...FILE_IO_TOOLS],
```

- [ ] **Step 3: Update test assertion**

In `pi-memory/tests/agent-runner.test.ts`, the assertion at line ~59 already uses a literal:

```ts
expect(opts.tools).toEqual(["read", "write", "edit", "ls"]);
```

No change needed — the value is the same.

- [ ] **Step 4: Run tests to verify**

Run: `cd pi-memory && npx vitest run`
Expected: 141 tests PASS

- [ ] **Step 5: Commit**

```bash
git add pi-memory/src/agent-config.ts pi-memory/src/agent-runner.ts
git commit -m "refactor: rename MEMORY_AGENT_TOOLS → FILE_IO_TOOLS"
```

---

### Task 2: Add `tools` and `customTools` params to `HeadlessAgentOpts`

**Files:**
- Modify: `pi-memory/src/agent-runner.ts`
- Modify: `pi-memory/tests/agent-runner.test.ts`

**Interfaces:**
- Produces: `HeadlessAgentOpts.tools?: string[]`, `HeadlessAgentOpts.customTools?: ToolDefinition[]`
- Consumes: `FILE_IO_TOOLS` from Task 1

- [ ] **Step 1: Add params to interface and wire into createAgentSession**

In `pi-memory/src/agent-runner.ts`, add the import:

```ts
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
```

Add to `HeadlessAgentOpts`:

```ts
export interface HeadlessAgentOpts {
	// ... existing fields ...
	/** Built-in tool name allowlist. Defaults to FILE_IO_TOOLS. Pass [] for no built-in tools. */
	tools?: string[];
	/** Custom tool definitions. Defaults to []. */
	customTools?: ToolDefinition[];
}
```

Update the `createAgentSession` call:

```ts
const created = await createAgentSession({
	cwd: opts.cwd,
	tools: opts.tools ?? [...FILE_IO_TOOLS],
	customTools: opts.customTools ?? [],
	model: resolvedModel as any,
	thinkingLevel: opts.thinkLevel as any,
	modelRegistry: opts.modelRegistry,
	sessionManager: SessionManager.inMemory(opts.cwd),
	settingsManager,
	resourceLoader: loader,
});
```

- [ ] **Step 2: Add tests**

In `pi-memory/tests/agent-runner.test.ts`, add two new test cases at the end of the `runHeadlessAgent` describe block (before the closing `});`):

```ts
it("uses default FILE_IO_TOOLS when tools is not provided", async () => {
	subscribeMock.mockImplementation((listener: any) => {
		queueMicrotask(() => {
			listener({ type: "message_end", message: {} });
			listener({ type: "turn_end", message: {}, toolResults: [] });
			listener({ type: "agent_end", messages: [], willRetry: false });
		});
		return () => {};
	});

	await runHeadlessAgent({
		task: "x",
		cwd: "/mem",
		modelRegistry: fakeRegistry,
		parentModel: {} as any,
	});
	const opts = createAgentSessionMock.mock.calls[0][0];
	expect(opts.tools).toEqual(["read", "write", "edit", "ls"]);
});

it("passes custom tools and empty built-in tools when specified", async () => {
	subscribeMock.mockImplementation((listener: any) => {
		queueMicrotask(() => {
			listener({ type: "message_end", message: {} });
			listener({ type: "turn_end", message: {}, toolResults: [] });
			listener({ type: "agent_end", messages: [], willRetry: false });
		});
		return () => {};
	});

	const customTool = { name: "my_tool", description: "custom", parameters: {}, execute: async () => ({ content: [] }) };
	await runHeadlessAgent({
		task: "x",
		cwd: "/mem",
		modelRegistry: fakeRegistry,
		parentModel: {} as any,
		tools: [],
		customTools: [customTool],
	});
	const opts = createAgentSessionMock.mock.calls[0][0];
	expect(opts.tools).toEqual([]);
	expect(opts.customTools).toEqual([customTool]);
});
```

- [ ] **Step 3: Run tests**

Run: `cd pi-memory && npx vitest run`
Expected: 143 tests PASS

- [ ] **Step 4: Commit**

```bash
git add pi-memory/src/agent-runner.ts pi-memory/tests/agent-runner.test.ts
git commit -m "feat: add tools and customTools params to HeadlessAgentOpts"
```

---

### Task 3: Add `replaceFrontmatterField` helper to `topic-file.ts`

**Files:**
- Modify: `pi-memory/src/topic-file.ts`
- Modify: `pi-memory/tests/topic-file.test.ts`

**Interfaces:**
- Produces: `export function replaceFrontmatterField(raw: string, field: string, value: string): string`

- [ ] **Step 1: Write failing tests**

Append to `pi-memory/tests/topic-file.test.ts` (before the last closing `});` of the file):

```ts
describe("replaceFrontmatterField", () => {
  const raw = [
    "---",
    "name: Debugging",
    "description: old description",
    "type: feedback",
    "updated: 2026-07-03",
    "---",
    "",
    "## Entry",
    "body",
  ].join("\n");

  it("replaces an existing field value", () => {
    const result = replaceFrontmatterField(raw, "description", "new description");
    expect(result).toContain("description: new description");
    expect(result).not.toContain("description: old description");
    expect(result).toContain("name: Debugging");
    expect(result).toContain("## Entry");
  });

  it("is a no-op when the field is not found", () => {
    const result = replaceFrontmatterField(raw, "nonexistent", "value");
    expect(result).toBe(raw);
  });

  it("handles frontmatter with only one field", () => {
    const minimal = "---\ndescription: only\n---\n\n## Entry\nbody";
    const result = replaceFrontmatterField(minimal, "description", "replaced");
    expect(result).toContain("description: replaced");
    expect(result).not.toContain("description: only");
  });

  it("returns input unchanged when no frontmatter exists", () => {
    const noFm = "## Just a heading\ncontent";
    const result = replaceFrontmatterField(noFm, "description", "value");
    expect(result).toBe(noFm);
  });
});
```

Add import at top of test file:

```ts
import { replaceFrontmatterField } from "../src/topic-file";
```

Update the import line:

```ts
import {
  buildFrontmatter,
  appendContent,
  updateFrontmatterDate,
  removeEntrySection,
  hasEntries,
  parseEntries,
  parseFrontmatter,
  replaceFrontmatterField,
  ALLOWED_TYPES,
  type TopicMeta,
} from "../src/topic-file";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-memory && npx vitest run tests/topic-file.test.ts`
Expected: FAIL — `replaceFrontmatterField is not exported`

- [ ] **Step 3: Implement `replaceFrontmatterField`**

In `pi-memory/src/topic-file.ts`, add the function after `updateFrontmatterDate`:

```ts
export function replaceFrontmatterField(raw: string, field: string, value: string): string {
	const regex = new RegExp(`^(---\n(?:.*\n)*?)${field}: .+(\n)`, "m");
	return raw.replace(regex, `$1${field}: ${value}$2`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pi-memory && npx vitest run tests/topic-file.test.ts`
Expected: 26 tests PASS (22 existing + 4 new)

- [ ] **Step 5: Commit**

```bash
git add pi-memory/src/topic-file.ts pi-memory/tests/topic-file.test.ts
git commit -m "feat: add replaceFrontmatterField helper"
```

---

### Task 4: Fix description in `doAdd` and `doRemove`

**Files:**
- Modify: `pi-memory/src/memory-tool.ts`
- Modify: `pi-memory/tests/memory-tool.test.ts`

**Interfaces:**
- Consumes: `replaceFrontmatterField` from Task 3, `parseEntries` from `topic-file.ts`
- Produces: `doAdd` and `doRemove` now update frontmatter `description` to match hook

- [ ] **Step 1: Add import for `replaceFrontmatterField`**

In `pi-memory/src/memory-tool.ts`, update the topic-file import:

```ts
import {
	appendContent,
	buildFrontmatter,
	hasEntries,
	parseEntries,
	removeEntrySection,
	replaceFrontmatterField,
	updateFrontmatterDate,
} from "./topic-file";
```

- [ ] **Step 2: Fix `doAdd` existing-topic branch**

In `pi-memory/src/memory-tool.ts`, inside the `else` block of `doAdd` (the existing-topic path), after `const topicContent = appendContent(...)` and before `await writeFile(topicPath, topicContent, "utf8");`, add description update:

Replace this block:

```ts
			// Build hook from all entries (comma-separated titles, trimmed to ~150 chars)
			const allEntries = parseEntries(topicContent);
			const hook = allEntries
				.map((e) => e.title)
				.join("; ")
				.slice(0, 150);
			next = updateHook(entries, topic, hook);
```

With:

```ts
			// Build hook + description from all entries (comma-separated titles, trimmed to ~150 chars)
			const allEntries = parseEntries(topicContent);
			const hook = allEntries
				.map((e) => e.title)
				.join("; ")
				.slice(0, 150);
			const withDesc = replaceFrontmatterField(topicContent, "description", hook);
			await writeFile(topicPath, withDesc, "utf8");
			next = updateHook(entries, topic, hook);
```

Note: the old `await writeFile(topicPath, topicContent, "utf8");` line needs to be removed since `withDesc` is now written instead. Check the surrounding code — the write for `topicContent` was on the line before the "Build hook" comment. Actually, looking at the code:

```ts
const topicContent = appendContent(refreshed, p.title, p.content);
await writeFile(topicPath, topicContent, "utf8");

// Build hook from all entries
const allEntries = parseEntries(topicContent);
```

Wait, the write happens BEFORE the hook is built. Let me re-read the exact code...

```ts
else {
	// Existing topic: append entry, then regenerate hook from ALL entry titles
	const raw = await readFile(topicPath, "utf8");
	const refreshed = updateFrontmatterDate(raw, today());
	const topicContent = appendContent(refreshed, p.title, p.content);
	await writeFile(topicPath, topicContent, "utf8");

	// Build hook from all entries (comma-separated titles, trimmed to ~150 chars)
	const allEntries = parseEntries(topicContent);
	const hook = allEntries
		.map((e) => e.title)
		.join("; ")
		.slice(0, 150);
	next = updateHook(entries, topic, hook);
```

So the topic file is written `topicContent` (with updated date), then hook is computed from `topicContent` (which is correct — same content). But the description in the written file is stale.

The fix: compute hook from topicContent, use replaceFrontmatterField, then write.

```ts
else {
	// Existing topic: append entry, then regenerate hook + description from ALL entry titles
	const raw = await readFile(topicPath, "utf8");
	const refreshed = updateFrontmatterDate(raw, today());
	const topicContent = appendContent(refreshed, p.title, p.content);

	// Build hook + description from all entries
	const allEntries = parseEntries(topicContent);
	const hook = allEntries
		.map((e) => e.title)
		.join("; ")
		.slice(0, 150);
	const withDesc = replaceFrontmatterField(topicContent, "description", hook);
	await writeFile(topicPath, withDesc, "utf8");

	next = updateHook(entries, topic, hook);
```

This replaces both the `await writeFile(topicPath, topicContent, ...)` and the subsequent hook computation with the unified version.

- [ ] **Step 3: Fix `doRemove` has-entries branch**

In `pi-memory/src/memory-tool.ts`, inside the `if (hasEntries(afterRemoval))` block of `doRemove`, update the description too. Current code:

```ts
if (hasEntries(afterRemoval)) {
	const remaining = parseEntries(afterRemoval);
	const newHook = remaining.length > 0 ? remaining[0].title : "";
	const nextEntries = updateHook(entries, topicFile, newHook);
	const refreshed = updateFrontmatterDate(afterRemoval, today());
	await writeFile(topicPath, refreshed, "utf8");
```

New code (compute hook from all entries, update description too):

```ts
if (hasEntries(afterRemoval)) {
	const remaining = parseEntries(afterRemoval);
	const newHook = remaining.map((e) => e.title).join("; ").slice(0, 150);
	const nextEntries = updateHook(entries, topicFile, newHook);
	const withDate = updateFrontmatterDate(afterRemoval, today());
	const withDesc = replaceFrontmatterField(withDate, "description", newHook);
	await writeFile(topicPath, withDesc, "utf8");
```

Note: changed `newHook` from `remaining[0].title` to the full `join("; ")` pattern (matching doAdd's hook generation).

- [ ] **Step 4: Write tests**

In `pi-memory/tests/memory-tool.test.ts`, add two new test cases.

In the `doAdd` describe block, after "refreshes updated date on append to existing topic", add:

```ts
it("updates description on append to existing topic to match hook", async () => {
	await doAdd(dir, {
		content: "first note",
		topic: "misc.md",
		title: "Entry One",
		maxLines: 200,
		maxBytes: 25600,
	});
	await doAdd(dir, {
		content: "second note",
		topic: "misc.md",
		title: "Entry Two plus more",
		maxLines: 200,
		maxBytes: 25600,
	});
	const topic = await readFile(join(dir, "misc.md"), "utf8");
	// description should be regenerated from all entry titles
	expect(topic).toContain("description: Entry One; Entry Two plus more");
	// MEMORY.md hook should match description
	const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
	expect(mem).toContain("Entry One; Entry Two plus more");
});
```

In the `doRemove` describe block, after "refreshes updated date after removing one entry from multi-entry topic", add:

```ts
it("updates description after removing one entry from multi-entry topic", async () => {
	await doAdd(dir, {
		content: "first",
		topic: "misc.md",
		title: "Entry Alpha",
		maxLines: 200,
		maxBytes: 25600,
	});
	await doAdd(dir, {
		content: "second",
		topic: "misc.md",
		title: "Entry Beta",
		maxLines: 200,
		maxBytes: 25600,
	});
	await doRemove(dir, { entry: "Entry Alpha" });
	const topic = await readFile(join(dir, "misc.md"), "utf8");
	expect(topic).toContain("description: Entry Beta");
	const mem = await readFile(join(dir, "MEMORY.md"), "utf8");
	expect(mem).toContain("Entry Beta");
});
```

Also update the existing test "removes entry by title: deletes ## block and updates hook" — it currently checks `expect(mem).toContain("MySQL Timeout");` for the hook. After the fix, the hook format changes from `firstEntryTitle` (for single remaining entry) to `"MySQL Timeout"` which is still correct since it's a single entry. But let's verify: with one remaining entry, `join("; ")` produces just the title without separator. So the existing test should still pass.

- [ ] **Step 5: Run tests**

Run: `cd pi-memory && npx vitest run tests/memory-tool.test.ts`
Expected: 28 tests PASS (24 existing + 2 new description tests + 2 = wait, let me count: existing doAdd tests: 8, doRemove: 5, doRead: 6, searchMemory: 4 = 23 total. Plus 2 new = 25. All should pass.)

- [ ] **Step 6: Run full test suite**

Run: `cd pi-memory && npx vitest run`
Expected: 145 tests PASS

- [ ] **Step 7: Commit**

```bash
git add pi-memory/src/memory-tool.ts pi-memory/tests/memory-tool.test.ts
git commit -m "fix: update frontmatter description on add/remove to stay in sync with hook"
```

---

### Task 5: Export `createMemoryTools` from `memory-tool.ts`

**Files:**
- Modify: `pi-memory/src/memory-tool.ts`
- Modify: `pi-memory/tests/memory-tool.test.ts`

**Interfaces:**
- Produces: `export function createMemoryTools(memoryDir: string, cfg: { maxLines: number; maxBytes: number }): ToolDefinition[]`
- Consumes: `doAdd`, `doRead`, `searchMemory` from `memory-tool.ts`

- [ ] **Step 1: Add import for ToolDefinition**

In `pi-memory/src/memory-tool.ts`, add:

```ts
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
```

- [ ] **Step 2: Implement `createMemoryTools`**

Add at the end of `pi-memory/src/memory-tool.ts` (after `createMemoryTool`):

```ts
export function createMemoryTools(
	memoryDir: string,
	cfg: { maxLines: number; maxBytes: number },
): ToolDefinition[] {
	return [
		{
			name: "memory_add",
			description:
				"Add a new memory entry to a topic file. Creates the topic if it doesn't exist. Use memory_read first to check for existing topics.",
			parameters: Type.Object({
				content: Type.String({ description: "Knowledge text to store." }),
				topic: Type.String({ description: "Target topic filename, e.g. 'debugging.md'." }),
				title: Type.String({
					description:
						"Descriptive, self-contained title. Only index lines are injected into prompts — make titles self-descriptive.",
				}),
				type: Type.Optional(
					StringEnum(["user", "feedback", "project", "reference"] as const),
				),
			}),
			async execute(
				_id: string,
				params: any,
				_signal: AbortSignal | undefined,
				_onUpdate: any,
				_ctx: any,
			) {
				if (!params.content) throw new Error("content is required");
				if (!params.topic) throw new Error("topic is required");
				if (!params.title) throw new Error("title is required");
				const r = await doAdd(memoryDir, {
					content: params.content,
					topic: params.topic,
					title: params.title,
					type: params.type,
					maxLines: cfg.maxLines,
					maxBytes: cfg.maxBytes,
				});
				if (!r.ok) throw new Error(r.error);
				return {
					content: [{
						type: "text",
						text: `Added "${params.title}" to ${params.topic}. Index has ${r.entries?.length ?? 0} entries.`,
					}],
				};
			},
		},
		{
			name: "memory_read",
			description:
				"Read a topic file (by topic name) or a single entry (by entry title). Use this to check for existing topics before adding new memories.",
			parameters: Type.Object({
				topic: Type.Optional(
					Type.String({ description: "Topic filename, e.g. 'debugging.md' or 'debugging'." }),
				),
				entry: Type.Optional(
					Type.String({ description: "Entry title to read a single entry." }),
				),
			}),
			async execute(
				_id: string,
				params: any,
				_signal: AbortSignal | undefined,
				_onUpdate: any,
				_ctx: any,
			) {
				if (!params.topic && !params.entry) throw new Error("topic or entry is required");
				const r = await doRead(memoryDir, { topic: params.topic, entry: params.entry });
				if (!r.ok) throw new Error(r.error);
				return { content: [{ type: "text", text: r.content ?? "" }] };
			},
		},
		{
			name: "memory_search",
			description:
				"Search all memory topic files for entries matching a query. Case-insensitive. Use this to find related memories before adding new ones.",
			parameters: Type.Object({
				query: Type.String({ description: "Search query." }),
			}),
			async execute(
				_id: string,
				params: any,
				_signal: AbortSignal | undefined,
				_onUpdate: any,
				_ctx: any,
			) {
				if (!params.query) throw new Error("query is required");
				const text = await searchMemory(memoryDir, params.query);
				return { content: [{ type: "text", text }] };
			},
		},
	];
}
```

- [ ] **Step 3: Write tests**

In `pi-memory/tests/memory-tool.test.ts`, add a new describe block at the end:

```ts
describe("createMemoryTools", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-tools-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("returns three tool definitions", () => {
		const tools = createMemoryTools(dir, { maxLines: 200, maxBytes: 25600 });
		expect(tools).toHaveLength(3);
		expect(tools.map((t) => t.name).sort()).toEqual(["memory_add", "memory_read", "memory_search"]);
	});

	it("memory_add writes a topic file and returns ok", async () => {
		const tools = createMemoryTools(dir, { maxLines: 200, maxBytes: 25600 });
		const addTool = tools.find((t) => t.name === "memory_add")!;
		const result = await addTool.execute("id", {
			content: "staging uses port 2222",
			topic: "debugging.md",
			title: "SSH Gotcha",
		}, undefined, undefined, undefined);
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toContain("Added");
		const topic = await readFile(join(dir, "debugging.md"), "utf8");
		expect(topic).toContain("staging uses port 2222");
	});

	it("memory_read returns topic content", async () => {
		// Set up via doAdd first
		await doAdd(dir, {
			content: "some content",
			topic: "misc.md",
			title: "Entry",
			maxLines: 200,
			maxBytes: 25600,
		});
		const tools = createMemoryTools(dir, { maxLines: 200, maxBytes: 25600 });
		const readTool = tools.find((t) => t.name === "memory_read")!;
		const result = await readTool.execute("id", { topic: "misc" }, undefined, undefined, undefined);
		expect(result.content[0].text).toContain("## Entry");
	});

	it("memory_search finds matching entries", async () => {
		await doAdd(dir, {
			content: "port 2222 for SSH",
			topic: "net.md",
			title: "Port",
			maxLines: 200,
			maxBytes: 25600,
		});
		const tools = createMemoryTools(dir, { maxLines: 200, maxBytes: 25600 });
		const searchTool = tools.find((t) => t.name === "memory_search")!;
		const result = await searchTool.execute("id", { query: "2222" }, undefined, undefined, undefined);
		expect(result.content[0].text).toContain("port 2222 for SSH");
	});

	it("memory_add throws on missing required params", async () => {
		const tools = createMemoryTools(dir, { maxLines: 200, maxBytes: 25600 });
		const addTool = tools.find((t) => t.name === "memory_add")!;
		await expect(
			addTool.execute("id", { content: "x" }, undefined, undefined, undefined),
		).rejects.toThrow("topic is required");
	});
});
```

Add import at top of test file:

```ts
import { doAdd, doRemove, doRead, searchMemory, createMemoryTools } from "../src/memory-tool";
```

- [ ] **Step 4: Run tests**

Run: `cd pi-memory && npx vitest run tests/memory-tool.test.ts`
Expected: ~30 tests PASS (25 existing + 5 new for createMemoryTools)

Now, let me actually count the current test count: doAdd has 8, doRemove has 5 (last entry removed, not found, multiple matches, date refresh, remove and update hook = let me recount from the test file). Looking at the test file:

doAdd: new topic, append second, refresh date, over capacity, path traversal, missing title, explicit type, invalid type, parallel adds = 9
doRemove: remove entry + update hook (was 1 but has extra date refresh test = 2), delete topic + index, not found, multiple matches, date refresh = 5
doRead: topic w/o .md, topic w/ .md, entry, not found topic, not found entry, path traversal = 6
searchMemory: single match, multi-match, no match, case insensitive = 4

Total existing: 9 + 5 + 6 + 4 = 24

New tests: 2 (add desc + remove desc) from Task 4 + 5 (createMemoryTools) from Task 5 = 7

Total after Task 5: 31 tests in memory-tool.test.ts

- [ ] **Step 5: Commit**

```bash
git add pi-memory/src/memory-tool.ts pi-memory/tests/memory-tool.test.ts
git commit -m "feat: export createMemoryTools for headless extract agent"
```

---

### Task 6: Update `inject.ts` — pass `tools: []` to side-query

**Files:**
- Modify: `pi-memory/src/inject.ts`
- Modify: `pi-memory/tests/inject.test.ts`

**Interfaces:**
- Consumes: `HeadlessAgentOpts.tools` from Task 2

- [ ] **Step 1: Pass `tools: []` to `runHeadlessAgent` in `runSideQuery`**

In `pi-memory/src/inject.ts`, in the `runSideQuery` function, update the `runHeadlessAgent` call:

```ts
// Before
const result = await runHeadlessAgent({
	task,
	cwd: memoryDir,
	modelRegistry,
	model,
	parentModel,
	thinkLevel,
	maxTurns: 1,
	timeoutMs: 30_000,
});

// After
const result = await runHeadlessAgent({
	task,
	cwd: memoryDir,
	modelRegistry,
	model,
	parentModel,
	thinkLevel,
	maxTurns: 1,
	timeoutMs: 30_000,
	tools: [],
});
```

- [ ] **Step 2: Update test expectations**

In `pi-memory/tests/inject.test.ts`, update the `runSideQuery` tests. Each existing assertion that checks `runHeadlessAgentMock` calls needs to verify `tools: []` is passed.

Update the first test "calls runHeadlessAgent with maxTurns=1, timeoutMs=30000, thinkLevel, and parses selected_files":

```ts
expect(runHeadlessAgentMock).toHaveBeenCalledWith(
	expect.objectContaining({
		cwd: "/mem",
		thinkLevel: "off",
		maxTurns: 1,
		timeoutMs: 30_000,
		tools: [],
	}),
);
```

Update "forwards configured model string":

```ts
expect(runHeadlessAgentMock.mock.calls[0][0]).toMatchObject({
	model: "deepseek/deepseek-v4-flash",
	tools: [],
});
```

- [ ] **Step 3: Run tests**

Run: `cd pi-memory && npx vitest run tests/inject.test.ts`
Expected: 18 tests PASS

- [ ] **Step 4: Run full test suite**

Run: `cd pi-memory && npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add pi-memory/src/inject.ts pi-memory/tests/inject.test.ts
git commit -m "feat: side-query runs with zero tools"
```

---

### Task 7: Update `extract.ts` — customTools + new prompt

**Files:**
- Modify: `pi-memory/src/extract.ts`
- Modify: `pi-memory/tests/extract.test.ts`

**Interfaces:**
- Consumes: `HeadlessAgentOpts.customTools` from Task 2, `createMemoryTools` from Task 5
- Produces: Updated `RunExtractOpts` with `customTools`, updated `buildExtractTask` prompt

- [ ] **Step 1: Add import and update `RunExtractOpts`**

In `pi-memory/src/extract.ts`, add import:

```ts
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
```

Update `RunExtractOpts` to add `customTools`:

```ts
export interface RunExtractOpts {
	model?: string;
	thinkLevel: ThinkLevel;
	memoryDir: string;
	messages: Array<{ role: string; content: string }>;
	maxContextTokens: number;
	modelRegistry: ModelRegistry;
	parentModel?: Model<any>;
	customTools?: ToolDefinition[];
}
```

- [ ] **Step 2: Rewrite `buildExtractTask`**

Replace the entire `buildExtractTask` function:

```ts
export function buildExtractTask(
	memoryDir: string,
	messages: Array<{ role: string; content: string }>,
	maxTokens: number,
): string {
	const fromUser = messages.find((m) => m.role === "user");
	const fromAssistant = messages.findLast((m) => m.role === "assistant");
	const userText = fromUser?.content ?? "";
	const assistantText = fromAssistant?.content ?? "";

	const maxChars = maxTokens * 4;
	const truncatedUser = userText.slice(0, maxChars / 2);
	const truncatedAssistant = assistantText.slice(0, maxChars / 2);

	return [
		`You are a memory extraction agent. Your working directory is the memory directory at ${memoryDir}.`,
		"",
		"Analyze the conversation snippet below. If you find valuable learnings, persist them using the memory tools.",
		"",
		"You have three tools available:",
		"- memory_read: read existing topic files or entries to check for related memories",
		"- memory_search: search across all memory files for relevant existing entries",
		"- memory_add: persist a new memory entry to a topic file (creates the topic if new)",
		"",
		"Do NOT use file read/write/edit/ls tools. Only use memory_add, memory_read, and memory_search.",
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
		"- Use memory_read first to check for existing topic files on related subjects",
		"- Use memory_search to find overlapping or related memories before adding",
		"- Use descriptive, self-contained entry titles (only index lines are injected into future sessions)",
		'- Choose the appropriate type: user, feedback, project, reference (default "feedback")',
		"- Be concise but complete",
		"- If unsure, do NOT write anything",
		"",
		"=== Conversation ===",
		`User: ${truncatedUser}`,
		`Assistant: ${truncatedAssistant}`,
	].join("\n");
}
```

- [ ] **Step 3: Update `runExtract` to pass `customTools`**

In `pi-memory/src/extract.ts`, update the `runExtract` function:

```ts
export async function runExtract(opts: RunExtractOpts): Promise<void> {
	if (opts.messages.length === 0) return;
	const task = buildExtractTask(opts.memoryDir, opts.messages, opts.maxContextTokens);
	// fire-and-forget: runner disposes internally via finally
	runHeadlessAgent({
		task,
		cwd: opts.memoryDir,
		modelRegistry: opts.modelRegistry,
		model: opts.model,
		parentModel: opts.parentModel,
		thinkLevel: opts.thinkLevel,
		maxTurns: 5,
		timeoutMs: 120_000,
		tools: [],
		customTools: opts.customTools ?? [],
	}).catch(() => {
		/* silently ignore extract errors */
	});
}
```

- [ ] **Step 4: Update tests**

In `pi-memory/tests/extract.test.ts`, update existing tests and add new ones.

Update the import to include `vi` (already imported):

No import change needed.

Update "calls runHeadlessAgent with maxTurns=5 and configured thinkLevel":

```ts
it("calls runHeadlessAgent with maxTurns=5, tools=[], customTools, and configured thinkLevel (fire-and-forget)", () => {
	runHeadlessAgentMock.mockClear();
	const fakeTools = [{ name: "memory_add", description: "", parameters: {}, execute: async () => ({ content: [] }) }];
	runExtract({
		thinkLevel: "high",
		memoryDir: "/mem/x",
		messages: [{ role: "user", content: "hello" }],
		maxContextTokens: 2000,
		modelRegistry: {} as any,
		parentModel: { id: "parent" } as any,
		customTools: fakeTools,
	});

	expect(runHeadlessAgentMock).toHaveBeenCalledTimes(1);
	expect(runHeadlessAgentMock).toHaveBeenCalledWith(
		expect.objectContaining({
			cwd: "/mem/x",
			thinkLevel: "high",
			maxTurns: 5,
			parentModel: { id: "parent" },
			tools: [],
			customTools: fakeTools,
		}),
	);
	expect(runHeadlessAgentMock.mock.calls[0][0].task).toContain("/mem/x");
});
```

Update "passes configured model string when set":

```ts
it("passes configured model string when set", () => {
	runHeadlessAgentMock.mockClear();
	runExtract({
		model: "deepseek/deepseek-v4-flash",
		thinkLevel: "medium",
		memoryDir: "/mem/x",
		messages: [{ role: "user", content: "hello" }],
		maxContextTokens: 2000,
		modelRegistry: {} as any,
	});

	expect(runHeadlessAgentMock.mock.calls[0][0]).toMatchObject({
		model: "deepseek/deepseek-v4-flash",
		thinkLevel: "medium",
		tools: [],
	});
});
```

Update "skips when messages array is empty" — no change needed (already checks `runHeadlessAgentMock` not called).

Add new test for prompt content:

```ts
it("buildExtractTask instructs LLM to use memory tools not file I/O", () => {
	const messages = [
		{ role: "user", content: "help" },
		{ role: "assistant", content: "answer" },
	];
	const task = buildExtractTask("/mem", messages, 2000);
	expect(task).toContain("memory_add");
	expect(task).toContain("memory_read");
	expect(task).toContain("memory_search");
	expect(task).not.toContain("file read/write/edit tools");
	expect(task).not.toContain("write/edit tools to directly modify");
});
```

- [ ] **Step 5: Run tests**

Run: `cd pi-memory && npx vitest run tests/extract.test.ts`
Expected: 6 tests PASS (5 existing + 1 new)

- [ ] **Step 6: Run full test suite**

Run: `cd pi-memory && npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add pi-memory/src/extract.ts pi-memory/tests/extract.test.ts
git commit -m "feat: extract uses memory tools instead of raw file I/O"
```

---

### Task 8: Update `index.ts` — extract call site passes `customTools`

**Files:**
- Modify: `pi-memory/index.ts`

**Interfaces:**
- Consumes: `createMemoryTools` from Task 5, `HeadlessAgentOpts.customTools` from Task 2

- [ ] **Step 1: Import `createMemoryTools`**

In `pi-memory/index.ts`, update the import:

```ts
import { createMemoryTool, createMemoryTools } from "./src/memory-tool";
```

- [ ] **Step 2: Pass `customTools` in extract call site**

In `pi-memory/index.ts`, in the `agent_end` handler, update the `runExtract` call:

```ts
runExtract({
	model: extractConfig.model,
	thinkLevel: extractConfig.thinkLevel,
	memoryDir,
	modelRegistry: ctx.modelRegistry,
	parentModel: ctx.model,
	customTools: createMemoryTools(memoryDir, {
		maxLines: config.memIndexMaxLines,
		maxBytes: config.memIndexMaxBytes,
	}),
	messages: event.messages.map((m) => ({
```

Note: insert `customTools` line before `messages`.

- [ ] **Step 3: Run index-wiring test**

Run: `cd pi-memory && npx vitest run tests/index-wiring.test.ts`
Expected: 4 tests PASS (the wiring mock for `extractMemories.enabled` is `false` in the test, so `runExtract` won't actually be called — the test won't exercise this change, but it won't break either)

- [ ] **Step 4: Run full test suite**

Run: `cd pi-memory && npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add pi-memory/index.ts
git commit -m "feat: wire createMemoryTools into extract agent_end handler"
```
