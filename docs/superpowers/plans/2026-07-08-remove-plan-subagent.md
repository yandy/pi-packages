# Remove Plan Subagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the built-in "Plan" subagent from pi-subagents, keeping only "general-purpose" and "Explore".

**Approach:** TDD — update tests first to reflect the desired state (no Plan), verify they FAIL because Plan still exists. Then remove Plan from source. Then verify all tests PASS.

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- Only remove "Plan", do not add anything
- TDD order: tests first, then source, then docs
- No functional change to "general-purpose" or "Explore" agents

---

### Task 1: Update tests/config/agent-types.test.ts — expect no Plan

**Files:**
- Modify: `pi-subagents/tests/config/agent-types.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_AGENTS` (still has Plan), `DEFAULT_AGENT_NAMES` (still has Plan)
- Produces: Tests that expect only 2 default agents (will FAIL until source changes)

**Expected after this task:** Tests FAIL — Plan still in source, but tests expect it gone.

- [ ] **Step 1: Remove Plan assertion from "loads default agents on construction" (line 28)**

Change:
```typescript
expect(registry.isValidType("Explore")).toBe(true);
expect(registry.isValidType("Plan")).toBe(true);
```
to (remove the Plan line, Explore already checked):
```typescript
expect(registry.isValidType("Explore")).toBe(true);
```

- [ ] **Step 2: Switch disabled-agent test from Plan to Explore (line 109)**

Change:
```typescript
new Map([["Plan", makeAgentConfig({ name: "Plan", description: "Disabled", enabled: false })]]),
```
to:
```typescript
new Map([["Explore", makeAgentConfig({ name: "Explore", description: "Disabled", enabled: false })]]),
```

- [ ] **Step 3: Update corresponding assertions (lines 111-112)**

Change:
```typescript
const config = registry.resolveAgentConfig("Plan");
expect(config.name).toBe("Plan");
```
to:
```typescript
const config = registry.resolveAgentConfig("Explore");
expect(config.name).toBe("Explore");
```

- [ ] **Step 4: Remove Plan from getAvailableTypes assertion (line 132)**

Change:
```typescript
expect(types).toContain("Explore");
expect(types).toContain("Plan");
```
to (remove the Plan line):
```typescript
expect(types).toContain("Explore");
```

- [ ] **Step 5: Switch disabled-agent exclusion test (line 136-137)**

Change:
```typescript
const registry = makeRegistry(new Map([["Plan", makeAgentConfig({ name: "Plan", enabled: false })]]));
expect(registry.getAvailableTypes()).not.toContain("Plan");
```
to:
```typescript
const registry = makeRegistry(new Map([["Explore", makeAgentConfig({ name: "Explore", enabled: false })]]));
expect(registry.getAvailableTypes()).not.toContain("Explore");
```

- [ ] **Step 6: Switch getAllTypes includes disabled test (lines 148-149)**

Change:
```typescript
const registry = makeRegistry(new Map([["Plan", makeAgentConfig({ name: "Plan", enabled: false })]]));
expect(registry.getAllTypes()).toContain("Plan");
```
to:
```typescript
const registry = makeRegistry(new Map([["Explore", makeAgentConfig({ name: "Explore", enabled: false })]]));
expect(registry.getAllTypes()).toContain("Explore");
```

- [ ] **Step 7: Remove Plan from getDefaultAgentNames assertion (line 159)**

Remove the line:
```typescript
expect(names).toContain("Plan");
```

- [ ] **Step 8: Switch isValidType disabled test from Plan to Explore (lines 192-193)**

Change:
```typescript
const registry = makeRegistry(new Map([["Plan", makeAgentConfig({ name: "Plan", enabled: false })]]));
expect(registry.isValidType("Plan")).toBe(false);
```
to:
```typescript
const registry = makeRegistry(new Map([["Explore", makeAgentConfig({ name: "Explore", enabled: false })]]));
expect(registry.isValidType("Explore")).toBe(false);
```

- [ ] **Step 9: Update DEFAULT_AGENT_NAMES assertion (line 236)**

Change:
```typescript
expect(AgentTypeRegistry.DEFAULT_AGENT_NAMES).toEqual(["general-purpose", "Explore", "Plan"]);
```
to:
```typescript
expect(AgentTypeRegistry.DEFAULT_AGENT_NAMES).toEqual(["general-purpose", "Explore"]);
```

- [ ] **Step 10: Update test description "three" → "two" (line 234)**

Change:
```typescript
it("contains the three built-in default names", () => {
```
to:
```typescript
it("contains the two built-in default names", () => {
```

- [ ] **Step 11: Run tests — expect FAILURE (Plan still in source)**

```bash
cd pi-subagents && npx vitest run tests/config/agent-types.test.ts
```

Expected: The `DEFAULT_AGENT_NAMES` assertion FAILS (still has Plan in source) + other assertions that reference Plan now fail. This is the "red" phase.

- [ ] **Step 12: Commit**

```bash
git add pi-subagents/tests/config/agent-types.test.ts
git commit -m "test: update agent-types tests to expect no Plan subagent"
```

---

### Task 2: Remove Plan prompt test in prompts.test.ts

**Files:**
- Modify: `pi-subagents/tests/session/prompts.test.ts:48-54`

**Interfaces:**
- Consumes: `getDefaultConfig` (still returns Plan for now)
- Produces: No Plan-related prompt test

- [ ] **Step 1: Remove the "Plan prompt is read-only" test block**

Delete lines 48-54:
```typescript
	it("Plan prompt is read-only", () => {
		const config = getDefaultConfig("Plan");
		const prompt = buildAgentPrompt(config, "/workspace", env);
		expect(prompt).toContain("READ-ONLY");
		expect(prompt).toContain("software architect");
	});
```

- [ ] **Step 2: Run tests — should PASS (just deleting a test)**

```bash
cd pi-subagents && npx vitest run tests/session/prompts.test.ts
```

Expected: All remaining tests PASS

- [ ] **Step 3: Commit**

```bash
git add pi-subagents/tests/session/prompts.test.ts
git commit -m "test: remove Plan prompt read-only test"
```

---

### Task 3: Update subagent-events-observer.test.ts — replace Plan with Explore

**Files:**
- Modify: `pi-subagents/tests/observation/subagent-events-observer.test.ts:163-173`

**Interfaces:**
- Consumes: none (test fixture creates a Subagent record directly)
- Produces: Tests use "Explore" instead of "Plan"

- [ ] **Step 1: Replace Plan with Explore in compacted subagent test**

Line 165 — change type:
```typescript
type: "Plan",
```
to:
```typescript
type: "Explore",
```

Line 173 — change type in assertion:
```typescript
type: "Plan",
```
to:
```typescript
type: "Explore",
```

- [ ] **Step 2: Run tests — should PASS (just a string change in test fixture)**

```bash
cd pi-subagents && npx vitest run tests/observation/subagent-events-observer.test.ts
```

Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add pi-subagents/tests/observation/subagent-events-observer.test.ts
git commit -m "test: replace Plan with Explore in events observer test"
```

---

### Task 4: Update service-adapter.test.ts — replace Plan with Explore

**Files:**
- Modify: `pi-subagents/tests/service/service-adapter.test.ts:164,256,259`

**Interfaces:**
- Consumes: none (test fixture creates Subagent records directly)
- Produces: Tests use "Explore" instead of "Plan"

- [ ] **Step 1: Replace Plan with Explore in recordB type (line 164)**

Change:
```typescript
type: "Plan",
```
to:
```typescript
type: "Explore",
```

- [ ] **Step 2: Replace Plan with Explore in spawn test (line 256)**

Change:
```typescript
svc.spawn("Plan", "plan work", { foreground: true });
```
to:
```typescript
svc.spawn("Explore", "plan work", { foreground: true });
```

- [ ] **Step 3: Replace Plan with Explore in spawn assertion (line 259)**

Change:
```typescript
"Plan",
```
to:
```typescript
"Explore",
```

- [ ] **Step 4: Run tests — should PASS**

```bash
cd pi-subagents && npx vitest run tests/service/service-adapter.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add pi-subagents/tests/service/service-adapter.test.ts
git commit -m "test: replace Plan with Explore in service adapter test"
```

---

### Task 5: Update spawn-config.test.ts — replace Plan with Explore

**Files:**
- Modify: `pi-subagents/tests/tools/spawn-config.test.ts:19-131`

**Interfaces:**
- Consumes: `AgentTypeRegistry` (still has Plan)
- Produces: Tests use disabled "Explore" override instead of disabled "Plan"

**Note:** These tests create a user-override "Explore" with `enabled: false`, which overrides the default Explore. This works because user agents override defaults in the registry.

- [ ] **Step 1: Rename helper and switch to Explore (lines 19-23)**

Change:
```typescript
/** Registry with a single disabled Plan override. */
function makeDisabledPlanRegistry(): AgentTypeRegistry {
	return new AgentTypeRegistry(
		() => new Map([["Plan", makeAgentConfig({ name: "Plan", description: "Disabled", enabled: false })]]),
	);
}
```
to:
```typescript
/** Registry with a single disabled Explore override. */
function makeDisabledExploreRegistry(): AgentTypeRegistry {
	return new AgentTypeRegistry(
		() => new Map([["Explore", makeAgentConfig({ name: "Explore", description: "Disabled", enabled: false })]]),
	);
}
```

- [ ] **Step 2: Update exact-match disabled test (lines 108-117)**

Change all `makeDisabledPlanRegistry` → `makeDisabledExploreRegistry`, `"Plan"` → `"Explore"`.

- [ ] **Step 3: Update case-insensitive disabled test (lines 122-131)**

Change all `makeDisabledPlanRegistry` → `makeDisabledExploreRegistry`, `"plan"` → `"explore"`, `"Plan"` → `"Explore"`.

- [ ] **Step 4: Run tests — should PASS**

```bash
cd pi-subagents && npx vitest run tests/tools/spawn-config.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add pi-subagents/tests/tools/spawn-config.test.ts
git commit -m "test: replace Plan with Explore in spawn-config tests"
```

---

### Task 6: Update helpers.test.ts — replace Plan with Explore

**Files:**
- Modify: `pi-subagents/tests/tools/helpers.test.ts:126-134`

**Interfaces:**
- Consumes: `buildTypeListText` (still resolves Plan from registry)
- Produces: Tests use "Explore" instead of "Plan" as disabled default agent

- [ ] **Step 1: Replace Plan with Explore (lines 126-134)**

Change:
```typescript
defaults: ["general-purpose", "Plan"],
resolve: (name) =>
	name === "Plan"
		? { description: "Planning agent", model: undefined, enabled: false }
		: { description: "General purpose agent", model: undefined },
...
expect(result).not.toContain("Plan");
```
to:
```typescript
defaults: ["general-purpose", "Explore"],
resolve: (name) =>
	name === "Explore"
		? { description: "Exploration agent", model: undefined, enabled: false }
		: { description: "General purpose agent", model: undefined },
...
expect(result).not.toContain("Explore");
```

- [ ] **Step 2: Run tests — should PASS**

```bash
cd pi-subagents && npx vitest run tests/tools/helpers.test.ts
```

Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add pi-subagents/tests/tools/helpers.test.ts
git commit -m "test: replace Plan with Explore in helpers tests"
```

---

### Task 7: Remove Plan from source — DEFAULT_AGENTS map

**Files:**
- Modify: `pi-subagents/src/config/default-agents.ts:67-107`

**Interfaces:**
- Consumes: none
- Produces: DEFAULT_AGENTS Map with only "general-purpose" and "Explore"

- [ ] **Step 1: Remove the Plan entry from DEFAULT_AGENTS**

Delete the entire `["Plan", { ... }]` entry (lines 67-107) plus its trailing comma.

The block to delete:
```typescript
	[
		"Plan",
		{
			name: "Plan",
			displayName: "Plan",
			description: "Software architect for implementation planning (read-only)",
			builtinToolNames: READ_ONLY_TOOLS,
			systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a software architect and planning specialist.
...
### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- /absolute/path/to/file.ts - [Brief reason]`,
			promptMode: "replace",
			isDefault: true,
		},
	],
```

Ensure the Explore entry before it ends with `},` and the closing `]);` follows immediately after.

- [ ] **Step 2: Commit**

```bash
git add pi-subagents/src/config/default-agents.ts
git commit -m "refactor: remove Plan from DEFAULT_AGENTS map"
```

---

### Task 8: Remove Plan from source — DEFAULT_AGENT_NAMES and comment

**Files:**
- Modify: `pi-subagents/src/config/agent-types.ts:34-35`

**Interfaces:**
- Consumes: none
- Produces: `DEFAULT_AGENT_NAMES` with only `["general-purpose", "Explore"]`

- [ ] **Step 1: Update DEFAULT_AGENT_NAMES**

Change line 35 from:
```typescript
static readonly DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const;
```
to:
```typescript
static readonly DEFAULT_AGENT_NAMES = ["general-purpose", "Explore"] as const;
```

- [ ] **Step 2: Update comment "three" → "two" (line 34)**

Change:
```typescript
/** The three embedded default agent names. */
```
to:
```typescript
/** The two embedded default agent names. */
```

- [ ] **Step 3: Commit**

```bash
git add pi-subagents/src/config/agent-types.ts
git commit -m "refactor: remove Plan from DEFAULT_AGENT_NAMES"
```

---

### Task 9: Full test suite verification — all tests PASS

**Files:**
- (none to modify, verification only)

- [ ] **Step 1: Run the full test suite**

```bash
cd pi-subagents && npx vitest run
```

Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

```bash
cd pi-subagents && npx tsc --noEmit
```

Expected: No type errors

- [ ] **Step 3: Commit if any final cleanup needed, or confirm done**

---

### Task 10: Update README documentation

**Files:**
- Modify: `pi-subagents/README.md:47`
- Modify: `pi-subagents/README.zh.md:47`

- [ ] **Step 1: Remove Plan row from README.md**

Remove the table row:
```
| `Plan` | read, bash, grep, find, ls | inherit | Software architect for implementation planning (read-only) |
```

- [ ] **Step 2: Remove Plan row from README.zh.md**

Remove the table row:
```
| `Plan` | read, bash, grep, find, ls | 继承父级 | 软件架构师，实现方案设计（只读） |
```

- [ ] **Step 3: Commit**

```bash
git add pi-subagents/README.md pi-subagents/README.zh.md
git commit -m "docs: remove Plan subagent from README tables"
```
