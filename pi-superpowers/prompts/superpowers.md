---
description: Execute the appropriate Superpowers workflow for a task
argument-hint: "<task description>"
---

Assess the task below and follow the corresponding Superpowers workflow.

**Task:** $ARGUMENTS

## Workflow Selection

Determine the task type and follow the matching workflow. Do NOT skip phases.

### New Feature / Creative Work

1. Load `/skill:superpowers-using-git-worktrees` — create or verify isolated workspace
2. Load `/skill:superpowers-brainstorming` — explore requirements, propose design, get approval
3. Load `/skill:superpowers-writing-plans` — create implementation plan, get approval
4. Load `/skill:superpowers-subagent-driven-development` (or `/skill:superpowers-executing-plans`) — execute plan task-by-task
5. Load `/skill:superpowers-finishing-a-development-branch` — merge, PR, or clean up

### Bug Fix

1. Load `/skill:superpowers-using-git-worktrees` — create or verify isolated workspace
2. Load `/skill:superpowers-systematic-debugging` — find root cause, propose fix
3. Load `/skill:superpowers-test-driven-development` — write failing test, implement fix
4. Load `/skill:superpowers-verification-before-completion` — verify fix works
5. Load `/skill:superpowers-finishing-a-development-branch` — merge, PR, or clean up

### Code Review

1. Load `/skill:superpowers-receiving-code-review` — process review feedback

## Rules

- Each phase completes and gets user approval before the next starts
- Never skip phases, even for "simple" tasks
- If unsure about task type, default to the New Feature workflow
