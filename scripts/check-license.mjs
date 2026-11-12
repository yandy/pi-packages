#!/usr/bin/env node
/**
 * 校验「全仓单一 LICENSE」约定是否符合 docs/guides/pi-package-spec.md 的「License」一节：
 *
 * - 根 package.json 必须声明 license，且与根 LICENSE 正文推断出的 SPDX 一致；
 * - 每个 workspace 的 license 字段必须与根完全相同（不允许各包自选许可）；
 * - 包目录内不得提交任何许可副本（LICENSE / LICENCE / COPYING / *.md 等），
 *   存在的副本内容必须与根一致（只允许 prepack 生成、postpack 删除）；
 * - prepack 的注入位置 `<pkg>/LICENSE` 必须被 .gitignore 忽略，否则残留副本可能被提交；
 * - 每个 workspace 必须挂 prepack/postpack 的 license.mjs 钩子，否则发布出的 tarball 里没有 LICENSE。
 *
 * 用法：npm run check:license
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 常见许可正文 → SPDX 标识。命中不了就不做比对（避免对非标准文本误判）。 */
const LICENSE_SIGNATURES = [
	{ spdx: "MIT", pattern: /^MIT License\s*$/m },
	{ spdx: "ISC", pattern: /\bISC License\b/ },
	{ spdx: "Apache-2.0", pattern: /Apache License\s+Version 2\.0/ },
	{ spdx: "BSD-3-Clause", pattern: /BSD 3-Clause/ },
	{ spdx: "BSD-2-Clause", pattern: /BSD 2-Clause/ },
	{ spdx: "GPL-3.0", pattern: /GNU GENERAL PUBLIC LICENSE\s+Version 3/ },
];

/** 包目录里会被称为「许可副本」的文件名（都是 npm 打包会带上的名字）。 */
const LICENSE_FILENAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "COPYING"];

const readJson = (path) => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		console.error(`无法解析 ${path}：${error.message}`);
		process.exit(1);
	}
};

/** git 不可用时返回 null，表示跳过相关校验（脚本仍可用于非 git 环境）。 */
const runGit = (args) => {
	const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
	if (result.error !== undefined) return null;
	return { status: result.status, stdout: result.stdout };
};

const isGitIgnored = (relPath) => {
	const result = runGit(["check-ignore", "--", relPath]);
	return result === null ? null : result.status === 0;
};

const gitLsFiles = () => {
	const result = runGit(["ls-files", "-z"]);
	return result === null ? null : new Set(result.stdout.split("\0").filter(Boolean));
};

const problems = [];
const rootPkg = readJson(join(repoRoot, "package.json"));
const rootLicensePath = join(repoRoot, "LICENSE");

if (!existsSync(rootLicensePath)) {
	problems.push("仓库根缺少 LICENSE");
}
const rootLicenseText = existsSync(rootLicensePath) ? readFileSync(rootLicensePath, "utf8") : "";

const rootSpdx = rootPkg.license;
if (typeof rootSpdx !== "string" || rootSpdx.length === 0) {
	problems.push('根 package.json: 缺少 "license" 字段（它是全仓许可的唯一来源）');
} else {
	const detected = LICENSE_SIGNATURES.find((signature) => signature.pattern.test(rootLicenseText));
	if (detected === undefined) {
		console.log("提示：无法从根 LICENSE 文本推断 SPDX 标识，跳过与根 package.json 的比对");
	} else if (detected.spdx !== rootSpdx) {
		problems.push(`根 package.json 的 license 是 "${rootSpdx}"，但 LICENSE 正文是 ${detected.spdx}`);
	}
}

const workspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
if (workspaces.length === 0) problems.push("根 package.json 没有 workspaces，无法校验各包 license");

const tracked = gitLsFiles();

for (const dir of workspaces) {
	const pkgPath = join(repoRoot, dir, "package.json");
	if (!existsSync(pkgPath)) {
		problems.push(`${dir}: 缺少 package.json（workspaces 配置与实际目录不一致）`);
		continue;
	}
	const pkg = readJson(pkgPath);

	if (pkg.license !== rootSpdx) {
		problems.push(
			`${dir}: license 是 ${JSON.stringify(pkg.license)}，必须与根 package.json 的 ${JSON.stringify(rootSpdx)} 一致`,
		);
	}

	const prepack = pkg.scripts?.prepack ?? "";
	const postpack = pkg.scripts?.postpack ?? "";
	if (!prepack.includes("scripts/license.mjs")) {
		problems.push(`${dir}: scripts.prepack 必须调用 "node ../scripts/license.mjs"（否则 tarball 里没有 LICENSE）`);
	}
	if (!postpack.includes("scripts/license.mjs") || !postpack.includes("--remove")) {
		problems.push(`${dir}: scripts.postpack 必须是 "node ../scripts/license.mjs --remove"（清掉 prepack 的副本）`);
	}

	for (const filename of LICENSE_FILENAMES) {
		const relPath = `${dir}/${filename}`;
		if (tracked?.has(relPath) === true) {
			problems.push(`${relPath}: 包内不得提交许可副本（发布时由 prepack 从根 LICENSE 注入）`);
		}
		const absPath = join(repoRoot, relPath);
		if (existsSync(absPath) && readFileSync(absPath, "utf8") !== rootLicenseText) {
			problems.push(`${relPath}: 与根 LICENSE 内容不一致。许可以根 LICENSE 为唯一来源，包内不留副本`);
		}
	}

	// 只对 prepack 实际使用的文件名要求被忽略，避免为别名文件写一堆规则；
	// 已跟踪的文件 run-git check-ignore 也返回非零，那种情况已由上面的「不得提交」报出。
	if (tracked?.has(`${dir}/LICENSE`) !== true && isGitIgnored(`${dir}/LICENSE`) === false) {
		problems.push(`${dir}/LICENSE: 未被 .gitignore 忽略，根 .gitignore 需保留 "/*/LICENSE" 规则`);
	}
}

if (problems.length > 0) {
	console.error("LICENSE 约定校验失败：");
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}

console.log(`LICENSE 约定校验通过（${workspaces.length} 个 workspace，统一为 ${rootSpdx}）`);
