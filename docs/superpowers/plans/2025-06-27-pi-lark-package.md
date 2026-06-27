# pi-lark Skills Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一个只包含 skills 的 pi package `pi-lark`，提供飞书（Lark）API skill 集合，通过 npm 分发给其他开发者使用。

**Architecture:** 纯 skills package，无 TS 扩展代码。`scripts/update-skills.mjs` 从飞书开放平台 well-known endpoint 自动下载 skills 到 `skills/` 目录。`prepublishOnly` 钩子确保发布前自动拉取最新 skills。

**Tech Stack:** Node.js (ESM), `package.json` pi manifest, `prepublishOnly` lifecycle hook

## Global Constraints

- 仅包含 skills，无 extensions / prompts / themes
- skills 从 `https://open.feishu.cn/.well-known/skills/index.json` (fallback: `/agent-skills/index.json`) 下载
- 下载脚本参考 `/home/yandy/workspace/pri/pi-feishu-cli/scripts/update-skills.mjs`
- `skills/` 目录不入 git，由 `update-skills` 脚本生成
- 发布 npm 时自动先运行下载脚本（`prepublishOnly`）

---

### Task 1: 创建 pi-lark package.json

**Files:**
- Create: `pi-lark/package.json`

**Interfaces:**
- Produces: `pi-lark` package with `pi.skills: ["./skills"]` manifest, `prepublishOnly` → `update-skills` script, `keywords: ["pi-package"]`, `files: ["skills/"]`

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
	"keywords": [
		"pi-package",
		"lark",
		"feishu",
		"skills"
	],
	"files": [
		"skills/"
	],
	"scripts": {
		"update-skills": "node scripts/update-skills.mjs",
		"prepublishOnly": "npm run update-skills"
	},
	"pi": {
		"skills": [
			"./skills"
		]
	}
}
```

- [ ] **Step 2: 验证**

```bash
node -e "const pkg = require('./pi-lark/package.json'); console.log(pkg.name, pkg.pi.skills)"
```

Expected: `@yandy0725/pi-lark [ './skills' ]`

---

### Task 2: 创建 update-skills.mjs 下载脚本

**Files:**
- Create: `pi-lark/scripts/update-skills.mjs`

**Interfaces:**
- Consumes: 飞书 well-known endpoint (`https://open.feishu.cn/.well-known/skills/index.json`, fallback `/agent-skills/index.json`)
- Produces: `pi-lark/skills/<skill-name>/SKILL.md` + reference 文件，以及 `pi-lark/.skills-cache.json` 缓存文件

参考脚本：`/home/yandy/workspace/pri/pi-feishu-cli/scripts/update-skills.mjs`（逻辑完全一致，仅调整路径到当前 package）

- [ ] **Step 1: 创建 pi-lark/scripts/update-skills.mjs**

```js
#!/usr/bin/env node

import { mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WELL_KNOWN_PATHS = [
	"/.well-known/skills/index.json",
	"/.well-known/agent-skills/index.json",
];

const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const SKILLS_DIR = resolve(PACKAGE_DIR, "skills");
const TMP_DIR = resolve(PACKAGE_DIR, "skills.tmp");
const CACHE_FILE = resolve(PACKAGE_DIR, ".skills-cache.json");

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
	await mkdir(TMP_DIR, { recursive: true });

	for (const skill of index.skills) {
		const skillDir = resolve(TMP_DIR, skill.name);
		console.log(`  ${skill.name}`);
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

	console.log("Updating index skills, preserving non-index directories...");
	for (const skill of index.skills) {
		const src = resolve(TMP_DIR, skill.name);
		const dst = resolve(SKILLS_DIR, skill.name);
		await rm(dst, { recursive: true, force: true });
		await rename(src, dst);
	}
	await rmdir(TMP_DIR);

	await writeFile(
		CACHE_FILE,
		JSON.stringify(
			{ endpoint, updatedAt: new Date().toISOString() },
			null,
			2,
		),
	);

	console.log("Done.");
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
```

- [ ] **Step 2: 试运行确认脚本可执行（不依赖网络）**

```bash
node --check pi-lark/scripts/update-skills.mjs
```

Expected: 无输出（语法正确）

---

### Task 3: 创建 .gitignore

**Files:**
- Create: `pi-lark/.gitignore`

**Interfaces:**
- Produces: 确保 `skills/` 和 `.skills-cache.json` 不入 git

- [ ] **Step 1: 创建 pi-lark/.gitignore**

```gitignore
skills/
.skills-cache.json
```

- [ ] **Step 2: 验证**

```bash
cat pi-lark/.gitignore
```

Expected: 显示上述两行

---

### Task 4: 创建文档文件

**Files:**
- Create: `pi-lark/README.md`
- Create: `pi-lark/README.zh.md`
- Create: `pi-lark/RELEASE.md`

**Interfaces:**
- Produces: 中英文 README 说明安装使用方式，RELEASE.md 说明发布流程

- [ ] **Step 1: 创建 pi-lark/README.md**

```markdown
# pi-lark

Pi package with Lark (Feishu) API skills for AI-powered Lark app development.

Provides a collection of skills covering Lark/Feishu open platform APIs: Base, Docs, Sheets, Calendar, IM, Approval, Drive, Wiki, and more.

## Install

```bash
pi install npm:@yandy0725/pi-lark
```

## Included Skills

Skills are automatically downloaded from Feishu Open Platform well-known endpoints. See the [skills/](./skills/) directory for the complete list after installation.

## Development

```bash
# Download/update skills from Feishu Open Platform
npm run update-skills
```

## License

MIT
```

- [ ] **Step 2: 创建 pi-lark/README.zh.md**

```markdown
# pi-lark

飞书（Lark）开放平台 API skills 集合，供 AI 辅助飞书应用开发使用。

涵盖飞书开放平台各类 API：多维表格、文档、电子表格、日历、即时通讯、审批、云盘、知识库等。

## 安装

```bash
pi install npm:@yandy0725/pi-lark
```

## 包含的 Skills

Skills 在发布时自动从飞书开放平台 well-known endpoint 下载。安装后可在 `skills/` 目录查看完整列表。

## 开发

```bash
# 从飞书开放平台下载/更新 skills
npm run update-skills
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
- `--workspace` 参数可用 `-w` 简写
- tag 格式必须是 `pi-lark-vX.Y.Z`
```

---

### Task 5: 修改根 package.json 和 publish.yml

**Files:**
- Modify: `package.json` — 添加 `pi-lark` 到 workspaces
- Modify: `.github/workflows/publish.yml` — 添加 `pi-lark-v*` 匹配分支

**Interfaces:**
- Consumes: 根 package.json workspaces 列表
- Produces: monorepo workspace 已包含 pi-lark，publish workflow 能识别 pi-lark 的 release tag

- [ ] **Step 1: 修改根 package.json workspaces**

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

具体操作：在 `"pi-vision-tools"` 行后添加 `"pi-lark"`。

- [ ] **Step 2: 修改 .github/workflows/publish.yml**

在 `case "$TAG" in` 块中添加：

```yaml
            pi-lark-v*)
              echo "dir=pi-lark" >> "$GITHUB_OUTPUT"
              ;;
```

插入位置：在 `pi-vision-tools-v*)` 分支之后，`esac` 之前。

- [ ] **Step 3: 验证 workspace 识别**

```bash
npm ls --workspace=pi-lark 2>&1 | head -5
```

Expected: 显示 `@yandy0725/pi-lark@0.1.0`

---

### Task 6: 验证下载脚本

**Files:**
- 验证: `pi-lark/scripts/update-skills.mjs`

- [ ] **Step 1: 运行下载脚本**

```bash
cd pi-lark && node scripts/update-skills.mjs
```

Expected: 
- 连接飞书开放平台探活
- 下载所有 skills 到 `skills/` 目录
- 生成 `.skills-cache.json`
- 输出 `Done.`

- [ ] **Step 2: 验证 skills 目录结构**

```bash
ls pi-lark/skills/ | head -10
```

Expected: 列出类似 `lark-base/`, `lark-im/`, `lark-doc/` 等目录

- [ ] **Step 3: 验证单个 skill 结构**

```bash
cat pi-lark/skills/lark-base/SKILL.md | head -10
```

Expected: 显示 SKILL.md 的 frontmatter（`name: lark-base`, `version: ...`）
