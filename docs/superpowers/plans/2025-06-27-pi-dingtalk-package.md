# pi-dingtalk Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** 创建纯 skills pi package `@yandy0725/pi-dingtalk`，从本地 `~/.dws/skills/multi/` 复制 skills，通过 npm 分发。

**Architecture:** 同 pi-lark。6 个文件 + 2 个现有文件修改。差异仅在 download-skills.mjs（本地复制代替 HTTP fetch）。

## Global Constraints

- 纯 skills 包，无 TS 代码、扩展、测试框架
- skills 源：本地 `~/.dws/skills/multi/`（需预装 `dingtalk-workspace-cli`）
- `skills/` 不入 git
- `prepublishOnly` 自动复制 skills，失败则中止发布
- peerDependency: `dingtalk-workspace-cli: "*"`（安装命令 `npm install -g dingtalk-workspace-cli`）
- Release tag: `pi-dingtalk-vX.Y.Z`

---

### Task 1: pi-dingtalk/package.json

Create `pi-dingtalk/package.json` with pi manifest, peerDependency on `dingtalk-workspace-cli`.

### Task 2: pi-dingtalk/scripts/download-skills.mjs

```js
#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const SKILLS_DIR = resolve(PACKAGE_DIR, "skills");
const SOURCE_DIR = resolve(homedir(), ".dws", "skills", "multi");

if (!existsSync(SOURCE_DIR)) {
  console.error("请先安装 dingtalk-workspace-cli: npm install -g dingtalk-workspace-cli");
  process.exit(1);
}

mkdirSync(SKILLS_DIR, { recursive: true });
execSync(`cp -r "${SOURCE_DIR}/"* "${SKILLS_DIR}/"`, { stdio: "inherit" });
console.log("Done.");
```

### Task 3: pi-dingtalk/.gitignore → `skills/`

### Task 4: README.md, README.zh.md, RELEASE.md

### Task 5: Monorepo integration (workspaces + publish.yml)

### Task 6: Verify
