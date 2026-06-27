# pi-lark — Design Spec

**Date:** 2025-06-27
**Status:** Approved

## Goal

一个只包含 skills 的 pi package，将飞书（Lark）开放平台 API skills 通过 npm 分发给其他开发者。

## Architecture

极简静态文件包。`scripts/download-skills.mjs` 从飞书开放平台 well-known endpoint 下载 skills 到 `skills/` 目录。`prepublishOnly` 确保发布时 skills 为最新。

```
pi-lark/
├── package.json
├── scripts/
│   └── download-skills.mjs
├── .gitignore
├── README.md
├── README.zh.md
└── RELEASE.md
```

- 无 TypeScript 代码、无扩展、无测试框架 —— 纯 skills 集合
- `skills/` 目录不入 git，由脚本生成，通过 npm 分发

## Components

### 1. package.json

```json
{
  "name": "@yandy0725/pi-lark",
  "publishConfig": { "access": "public" },
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
  "scripts": {
    "download-skills": "node scripts/download-skills.mjs",
    "prepublishOnly": "npm run download-skills"
  },
  "pi": {
    "skills": ["./skills"]
  }
}
```

- `pi.skills: ["./skills"]` — pi 自动发现 `skills/` 下所有 `SKILL.md`
- `files: ["skills/"]` — 只打包 skills 目录发布
- `prepublishOnly` → `download-skills` — 发布前自动拉最新 skills
- `scripts/download-skills` — 也支持手动 `npm run download-skills`
- 无 `dependencies`、`peerDependencies`

### 2. download-skills.mjs

```
Logic:
1. 确定 package 根目录 (scripts/../)
2. 依次探活两个 well-known endpoint:
   a. https://open.feishu.cn/.well-known/skills/index.json
   b. https://open.feishu.cn/.well-known/agent-skills/index.json
3. 取第一个返回 200 的，解析 JSON 得到 skills 列表
4. 遍历 skills:
   - mkdir skills/<name>/ (recursive, already exists is ok)
   - 下载每个 file → skills/<name>/<file>
5. 输出 "Done."
```

- 纯标准库：`node:fs/promises`、`node:path`、`node:url`
- 零外部依赖
- 网络错误 → `process.exit(1)`，终止 `prepublishOnly`

### 3. .gitignore

```
skills/
```

### 4. 文档

| File | Content |
|------|---------|
| `README.md` | Install via `pi install npm:@yandy0725/pi-lark`. Dev: `npm run download-skills`. |
| `README.zh.md` | 中文版同上 |
| `RELEASE.md` | Release via `npm version -w pi-lark --no-git-tag-version` → commit → `gh release create pi-lark-vX.Y.Z` |

### 5. Monorepo Integration

**根 `package.json` workspaces:**
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

**`.github/workflows/publish.yml`:**
```yaml
pi-lark-v*)
  echo "dir=pi-lark" >> "$GITHUB_OUTPUT"
  ;;
```

Release tag `pi-lark-vX.Y.Z` → CI 执行 `npm publish --provenance --workspace=pi-lark`，其中 `prepublishOnly` 先下载 skills。

## Constraints

- Release tag 格式：`pi-lark-vX.Y.Z`
- Package 名：`@yandy0725/pi-lark`（public access）
- skills 内容不归本仓库管理，由脚本从飞书平台拉取
