---
description: Execute the appropriate Superpowers workflow for a task
argument-hint: "<task description>"
---

Assess the task below and follow the corresponding Superpowers workflow.

<TASK>
$ARGUMENTS
</TASK>

## Workflow Selection

Determine the task type and follow the matching workflow. Do NOT skip phases.

### New Feature / Creative Work

1. Load `/skill:supo-using-git-worktrees` — create or verify isolated workspace
2. Load `/skill:supo-brainstorming` — explore requirements, propose design, get approval
3. Load `/skill:supo-writing-plans` — create implementation plan, get approval
4. Load `/skill:supo-subagent-driven-development` (or `/skill:supo-executing-plans`) — execute plan task-by-task
5. Load `/skill:supo-finishing-a-development-branch` — merge, PR, or clean up

### Bug Fix

1. Load `/skill:supo-using-git-worktrees` — create or verify isolated workspace
2. Load `/skill:supo-systematic-debugging` — find root cause, propose fix
3. Load `/skill:supo-test-driven-development` — write failing test, implement fix
4. Load `/skill:supo-verification-before-completion` — verify fix works
5. Load `/skill:supo-finishing-a-development-branch` — merge, PR, or clean up

### Code Review

1. Load `/skill:supo-receiving-code-review` — process review feedback

## Rules

- Each phase completes and gets user approval before the next starts
- Never skip phases, even for "simple" tasks
- If unsure about task type, default to the New Feature workflow
