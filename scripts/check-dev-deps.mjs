#!/usr/bin/env node
/**
 * 校验各 workspace 的 devDependencies 是否符合
 * docs/guides/pi-package-spec.md 的「依赖管理 → devDependencies」约定：
 *
 * - Extension 包（package.json 的 pi.extensions 非空）必须声明共享的 4 个
 *   devDependencies，且版本串与根 package.json 完全一致（根是版本唯一来源）；
 * - Pure Skills 包（pi.skills 非空）不得声明这些共享 devDependencies；
 * - 其他 workspace 跳过（仅提示，不算失败）。
 *
 * 用法：npm run check:dev-deps
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 规范要求所有 Extension 包统一声明的 devDependencies（版本以根 package.json 为准）。 */
const SHARED_DEV_DEPS = ["@biomejs/biome", "typescript", "@types/node", "vitest"];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		console.error(`无法解析 ${path}：${error.message}`);
		process.exit(1);
	}
};

const rootPkg = readJson(join(repoRoot, "package.json"));
const rootDevDeps = rootPkg.devDependencies ?? {};
const problems = [];

for (const dep of SHARED_DEV_DEPS) {
	if (rootDevDeps[dep] === undefined) {
		problems.push(`根 package.json: 缺少 devDependencies["${dep}"]（版本唯一来源）`);
	}
}

let extensionCount = 0;
let pureSkillsCount = 0;
const unclassified = [];

for (const workspace of rootPkg.workspaces ?? []) {
	const pkg = readJson(join(repoRoot, workspace, "package.json"));
	const devDeps = pkg.devDependencies ?? {};
	const label = pkg.name ?? workspace;
	const isExtension = Array.isArray(pkg.pi?.extensions) && pkg.pi.extensions.length > 0;
	const isPureSkills = !isExtension && Array.isArray(pkg.pi?.skills) && pkg.pi.skills.length > 0;

	if (!isExtension && !isPureSkills) {
		unclassified.push(label);
		continue;
	}

	if (isPureSkills) {
		pureSkillsCount++;
		for (const dep of SHARED_DEV_DEPS) {
			if (devDeps[dep] !== undefined) {
				problems.push(`${label}: Pure Skills 包不应声明 devDependencies["${dep}"]`);
			}
		}
		continue;
	}

	extensionCount++;
	for (const dep of SHARED_DEV_DEPS) {
		const expected = rootDevDeps[dep];
		if (devDeps[dep] === undefined) {
			problems.push(`${label}: 缺少 devDependencies["${dep}"]（应为 "${expected}"）`);
		} else if (devDeps[dep] !== expected) {
			problems.push(
				`${label}: devDependencies["${dep}"] = "${devDeps[dep]}"，与根 package.json 的 "${expected}" 不一致`,
			);
		}
	}
}

if (problems.length > 0) {
	console.error("devDependencies 一致性检查失败（规范：docs/guides/pi-package-spec.md）：");
	for (const problem of problems) console.error(`  - ${problem}`);
	console.error(`\n共 ${problems.length} 项问题。修复后运行 npm install 以同步 package-lock.json。`);
	process.exit(1);
}

if (unclassified.length > 0) {
	console.warn(`提示：以下 workspace 既非 Extension 也非 Pure Skills，已跳过检查：${unclassified.join("、")}`);
}

console.log(
	`devDependencies 一致性检查通过：${extensionCount} 个 Extension 包声明了与根一致的 ${SHARED_DEV_DEPS.join("、")}；` +
		`${pureSkillsCount} 个 Pure Skills 包未声明。`,
);
