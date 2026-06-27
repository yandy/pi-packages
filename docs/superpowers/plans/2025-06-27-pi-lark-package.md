# pi-lark Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建纯 skills pi package `@yandy0725/pi-lark`，从飞书 well-known endpoint 下载 skills，通过 npm 分发。

**Architecture:** 6 个文件（package.json、download-skills.mjs、.gitignore、README.md、README.zh.md、RELEASE.md）+ 2 个现有文件修改（根 package.json workspaces、publish.yml）。`skills/` gitignore，由 download-skills.mjs 生成。

**Tech Stack:** Node.js ESM（零外部依赖），npm workspaces monorepo，GitHub Actions OIDC publish

## Global Constraints

- 纯 skills 包，无 TS 代码、扩展、测试框架
- skills 源：`https://open.feishu.cn/.well-known/skills/index.json`（fallback `/agent-skills/index.json`）
- `skills/` 不入 git
- `prepublishOnly` 自动下载 skills，失败则中止发布
- peerDependency: `@larksuite/cli: "*"`（安装命令 `npm install -g @larksuite/cli`）
- Release tag: `pi-lark-vX.Y.Z`
- Package 名: `@yandy0725/pi-lark`

---

### Task 1: 创建 pi-lark/package.json

**Files:**
- Create: `pi-lark/package.json`

**Interfaces:**
- Produces: `@yandy0725/pi-lark` package manifest，声明 `pi.skills: ["./skills"]`、`prepublishOnly` → `download-skills`、`peerDependencies: { "@larksuite/cli": "*" }`、`files: ["skills/"]`、`type: "module"`

- [ ] **Step 1: 创建 pi-lark/package.json**

```json
{
	"name": "@yandy0725/pi-lark",
	"publishConfig": {
		"access": "public"
	},
	"version": "0.1.0",
	"description": "Pi package with Lark (Feishu) API skills for AI-powered Lark app development",
	"license": "MIT",
	"repository": {
		"type": "git",
		"url": "https://github.com/yandy/pi-packages",
		"directory": "pi-lark"
	},
	"type": "module",
	"keywords": ["pi-package", "lark", "feishu", "skills"],
	"files": ["skills/"],
	"peerDependencies": {
		"@larksuite/cli": "*"
	},
	"scripts": {
		"download-skills": "node scripts/download-skills.mjs",
		"prepublishOnly": "npm run download-skills"
	},
	"pi": {
		"skills": ["./skills"]
	}
}
```

- [ ] **Step 2: 验证 package.json 结构**

```bash
node -e "const p = require('./pi-lark/package.json'); console.log(p.name, p.pi.skills, p.peerDependencies)"
```

Expected: `@yandy0725/pi-lark [ './skills' ] { '@larksuite/cli': '*' }`

---

### Task 2: 创建 pi-lark/scripts/download-skills.mjs

**Files:**
- Create: `pi-lark/scripts/download-skills.mjs`

**Interfaces:**
- Consumes: `https://open.feishu.cn/.well-known/skills/index.json` 或 `/agent-skills/index.json`
- Produces: `pi-lark/skills/<skill-name>/SKILL.md` + reference 文件
- 零外部依赖（仅 `node:fs/promises`、`node:path`、`node:url`）

- [ ] **Step 1: 创建 pi-lark/scripts/download-skills.mjs**

```js
#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WELL_KNOWN_PATHS = [
	"/.well-known/skills/index.json",
	"/.well-known/agent-skills/index.json",
];

const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const SKILLS_DIR = resolve(PACKAGE_DIR, "skills");
const FEISHU_ORIGIN = "https://open.feishu.cn";

async function probeEndpoint() {
	for (const path of WELL_KNOWN_PATHS) {
		const url = `${FEISHU_ORIGIN}${path}`;
		try {
			const resp = await fetch(url);
			if (resp.ok) {
				return { endpoint: path, index: await resp.json() };
			}
		} catch {
			continue;
		}
	}
	throw new Error(
		`All well-known endpoints returned non-200:\n${WELL_KNOWN_PATHS.map((p) => `  ${FEISHU_ORIGIN}${p}`).join("\n")}`,
	);
}

function buildDownloadUrl(endpoint, skillName, file) {
	const baseDir = endpoint.replace(/\/[^/]+$/, "");
	return `${FEISHU_ORIGIN}${baseDir}/${skillName}/${file}`;
}

async function downloadFile(url, destPath) {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
	const dir = destPath.substring(0, destPath.lastIndexOf("/"));
	await mkdir(dir, { recursive: true });
	await writeFile(destPath, Buffer.from(await resp.arrayBuffer()));
}

async function main() {
	console.log("Probing well-known endpoints...");
	const { endpoint, index } = await probeEndpoint();
	console.log(`Using endpoint: ${endpoint} (${index.skills.length} skills)`);

	console.log("Downloading skills...");
	for (const skill of index.skills) {
		const skillDir = resolve(SKILLS_DIR, skill.name);
		console.log(`  ${skill.name}`);
		await mkdir(skillDir, { recursive: true });
		for (const file of skill.files) {
			const url = buildDownloadUrl(endpoint, skill.name, file);
			const dest = resolve(skillDir, file);
			try {
				await downloadFile(url, dest);
			} catch (err) {
				console.warn(`    ⚠ failed to download ${url}: ${err.message}`);
			}
		}
	}

	console.log("Done.");
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
```

- [ ] **Step 2: 语法检查**

```bash
node --check pi-lark/scripts/download-skills.mjs
```

Expected: 无输出（语法正确）

---

### Task 3: 创建 pi-lark/.gitignore

**Files:**
- Create: `pi-lark/.gitignore`

- [ ] **Step 1: 创建 pi-lark/.gitignore**

```
skills/
```

- [ ] **Step 2: 验证**

```bash
cat pi-lark/.gitignore
```

Expected: `skills/`

---

### Task 4: 创建文档文件

**Files:**
- Create: `pi-lark/README.md`
- Create: `pi-lark/README.zh.md`
- Create: `pi-lark/RELEASE.md`

- [ ] **Step 1: 创建 pi-lark/README.md**

```markdown
# pi-lark

Pi package with Lark (Feishu) API skills for AI-powered Lark app development.

Provides a collection of skills covering Lark/Feishu open platform APIs: Base, Docs, Sheets, Calendar, IM, Approval, Drive, Wiki, and more.

## Prerequisites

Install `@larksuite/cli` globally:

```bash
npm install -g @larksuite/cli
```

## Install

```bash
pi install npm:@yandy0725/pi-lark
```

## Development

```bash
# Download/update skills from Feishu Open Platform
npm run download-skills
```

## License

MIT
```

- [ ] **Step 2: 创建 pi-lark/README.zh.md**

```markdown
# pi-lark

飞书（Lark）开放平台 API skills 集合，供 AI 辅助飞书应用开发使用。

涵盖飞书开放平台各类 API：多维表格、文档、电子表格、日历、即时通讯、审批、云盘、知识库等。

## 前置条件

全局安装 `@larksuite/cli`：

```bash
npm install -g @larksuite/cli
```

## 安装

```bash
pi install npm:@yandy0725/pi-lark
```

## 开发

```bash
# 从飞书开放平台下载/更新 skills
npm run download-skills
```

## License

MIT
```

- [ ] **Step 3: 创建 pi-lark/RELEASE.md**

```markdown
# 发布新版本

发布通过 GitHub Actions 自动完成，触发条件是创建 GitHub Release（Release tag 格式 `pi-lark-v*`）。

## 操作步骤

```bash
# 在仓库根目录执行：

# 1. 升级版本号并提交
npm version <新版本号> --workspace=pi-lark --no-git-tag-version
git add pi-lark/package.json package-lock.json
git commit -m "pi-lark v<新版本号>"
COMMIT=$(git rev-parse HEAD)

# 2. 推送
git push origin main

# 3. 创建 GitHub Release（触发发布）
gh release create pi-lark-v<新版本号> --target $COMMIT \
  --title "pi-lark v<新版本号>" --notes ""
```

创建 Release 后，`.github/workflows/publish.yml` 响应 `release: published` 事件，执行 `npm ci` + `npm publish --provenance --workspace=pi-lark`（OIDC 认证，无需本地 npm token）。`prepublishOnly` 脚本会自动下载最新 skills 后再发布。

发布到：`@yandy0725/pi-lark@X.Y.Z`（public access）

## 注意事项

- `npm version --workspace` 在 monorepo 中不会自动 commit/tag（已用 `--no-git-tag-version`），需手动提交
- `gh release create` 会自动创建对应名称的 git tag，**无需手动 `git tag`**
- `--target` 指定 tag 指向的 commit，确保 tag 落在版本升级的那个 commit 上
- tag 格式必须是 `pi-lark-vX.Y.Z`
```

---

### Task 5: Monorepo 集成

**Files:**
- Modify: `package.json` — workspaces 数组添加 `"pi-lark"`
- Modify: `.github/workflows/publish.yml` — 添加 `pi-lark-v*` 匹配分支

- [ ] **Step 1: 修改根 package.json workspaces**

在 `"pi-vision-tools"` 之后添加 `"pi-lark"`：

```json
"workspaces": [
  "pi-coding-tools",
  "pi-container-sandbox",
  "pi-web-tools",
  "pi-todo",
  "pi-vision-tools",
  "pi-lark"
]
```

- [ ] **Step 2: 修改 .github/workflows/publish.yml**

在 `pi-vision-tools-v*)` 分支之后、`esac` 之前添加：

```yaml
            pi-lark-v*)
              echo "dir=pi-lark" >> "$GITHUB_OUTPUT"
              ;;
```

- [ ] **Step 3: 验证 workspace 识别**

```bash
npm ls --workspace=pi-lark 2>&1 | head -3
```

Expected: 显示 `@yandy0725/pi-lark@0.1.0`

---

### Task 6: 验证下载脚本

- [ ] **Step 1: 试运行**

```bash
cd pi-lark && node scripts/download-skills.mjs
```

Expected: 连接飞书，下载所有 skills 到 `skills/`，输出 `Done.`

- [ ] **Step 2: 检查 skills 目录**

```bash
ls pi-lark/skills/ | head -10
cat pi-lark/skills/lark-base/SKILL.md | head -5
```

Expected: 列出 skill 目录名，SKILL.md 有 frontmatter（`name: lark-base`）
