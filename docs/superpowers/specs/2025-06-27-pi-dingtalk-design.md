# pi-dingtalk — Design Spec

**Date:** 2025-06-27
**Status:** Approved

## Goal

一个只包含 skills 的 pi package，将钉钉（DingTalk）workspace CLI skills 通过 npm 分发给其他开发者。

## Architecture

极简静态文件包。`scripts/download-skills.mjs` 从本地 `~/.dws/skills/multi/` 复制 skills 到 `skills/` 目录。`prepublishOnly` 确保发布时 skills 为最新。

```
pi-dingtalk/
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
  "name": "@yandy0725/pi-dingtalk",
  "publishConfig": { "access": "public" },
  "version": "0.1.0",
  "description": "Pi package with DingTalk workspace CLI skills for AI-powered DingTalk development",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yandy/pi-packages",
    "directory": "pi-dingtalk"
  },
  "type": "module",
  "keywords": ["pi-package", "dingtalk", "skills"],
  "files": ["skills/"],
  "peerDependencies": {
    "dingtalk-workspace-cli": "*"
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

### 2. download-skills.mjs

```
Logic:
1. 检查 ~/.dws/skills/multi/ 是否存在
2. 存在 → 确保 skills/ 目录存在，copy 所有子目录到 skills/
3. 不存在 → process.exit(1)，提示 "请先安装 dingtalk-workspace-cli"
```

- 纯标准库：`node:fs`、`node:child_process`（`cp -r`）
- 零外部依赖
- 无网络访问

### 3. .gitignore

```
skills/
```

### 4. 文档

| File | Content |
|------|---------|
| `README.md` | Install via `pi install npm:@yandy0725/pi-dingtalk`. Prerequisite: `npm install -g dingtalk-workspace-cli`. Dev: `npm run download-skills`. |
| `README.zh.md` | 中文版同上 |
| `RELEASE.md` | Release via `npm version -w pi-dingtalk --no-git-tag-version` → commit → `gh release create pi-dingtalk-vX.Y.Z` |

### 5. Monorepo Integration

**根 `package.json` workspaces:**
```json
"workspaces": [
  "pi-coding-tools",
  "pi-container-sandbox",
  "pi-web-tools",
  "pi-todo",
  "pi-vision-tools",
  "pi-lark",
  "pi-dingtalk"
]
```

**`.github/workflows/publish.yml`:**
```yaml
pi-dingtalk-v*)
  echo "dir=pi-dingtalk" >> "$GITHUB_OUTPUT"
  ;;
```

## Constraints

- Release tag 格式：`pi-dingtalk-vX.Y.Z`
- Package 名：`@yandy0725/pi-dingtalk`（public access）
- skills 内容不归本仓库管理，从本地 `~/.dws/skills/multi/` 复制
- 依赖 `dingtalk-workspace-cli`（peerDependency），skills 内的指令需 `dws` 命令
- 发布环境需预装 `dingtalk-workspace-cli`（CI 中 `prepublishOnly` 会检查 `~/.dws/skills/multi/`）
