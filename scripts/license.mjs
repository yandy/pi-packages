#!/usr/bin/env node
/**
 * 在 pack/publish 期间把仓库根的 LICENSE 同步进当前包目录，打包完成后清理。
 *
 * 为什么需要它：npm 只会打包到包目录为根的子树，`files` 不能引用上级目录，
 * 符号链接指向包外的 LICENSE 也会被排除在 tarball 之外（实测 npm 24.x）。
 * 所以「全仓单一 LICENSE、包内不留副本」只能靠发布时临时复制实现。
 *
 * 用法（各 package.json）：
 *   "prepack":  "node ../scripts/license.mjs"
 *   "postpack": "node ../scripts/license.mjs --remove"
 *
 * npm 生命周期脚本的 cwd 是被打包的包目录，仓库根由本脚本自身位置推出。
 */
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "LICENSE");
const target = join(process.cwd(), "LICENSE");

if (process.argv.includes("--remove")) {
	if (existsSync(target)) rmSync(target);
	process.exit(0);
}

if (resolve(process.cwd()) === repoRoot) {
	console.error("license.mjs 是 prepack/postpack 钩子，应在包目录内运行，不能在仓库根运行");
	process.exit(1);
}

if (!existsSync(source)) {
	console.error(`找不到根 LICENSE：${source}`);
	process.exit(1);
}

// 已是同一份内容就不必重写，避免无意义的 mtime 变动。
const sourceText = readFileSync(source, "utf8");
if (existsSync(target) && readFileSync(target, "utf8") === sourceText) process.exit(0);

copyFileSync(source, target);
