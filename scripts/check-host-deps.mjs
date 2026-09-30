#!/usr/bin/env node
/**
 * 校验各 workspace 对「宿主提供包（host-provided packages）」的声明是否符合
 * docs/guides/pi-package-spec.md 的「依赖管理」约定：
 *
 * - 宿主提供包不得出现在任何 workspace 的 `dependencies`：pi 本体在加载扩展前会扫描
 *   扩展包的 package.json，命中即告警
 *   （"Host-provided extension packages must be declared in peerDependencies with a
 *   \"*\" range, not dependencies: ..."），且安装的副本可能旁路扩展加载器的模块映射，
 *   造成重复运行时模块；
 * - 源码中 import 了宿主提供包的 workspace，必须在 `peerDependencies` 中声明该包，
 *   由宿主在运行时提供实例；其中 typebox 系（`typebox` / `@sinclair/typebox`）按宿主
 *   要求使用 `*` 范围；
 * - `@earendil-works/*`、`@mariozechner/*` 等核心包的范围由仓库约定自行决定
 *   （当前为 `>=<最低宿主版本>`），本脚本只要求声明存在。
 *
 * 宿主提供包清单对齐 pi-coding-agent 的 HOST_PROVIDED_EXTENSION_PACKAGES。
 *
 * 用法：npm run check:host-deps
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 宿主在运行时提供的包（对齐 pi-coding-agent 的 HOST_PROVIDED_EXTENSION_PACKAGES）。 */
const HOST_PROVIDED_PACKAGES = new Set([
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@mariozechner/pi-agent-core",
	"@mariozechner/pi-ai",
	"@mariozechner/pi-coding-agent",
	"@mariozechner/pi-tui",
	"@sinclair/typebox",
	"typebox",
]);

/** 宿主要求以 `*` 声明范围的包（typebox 系）。 */
const WILDCARD_RANGE_PACKAGES = new Set(["typebox", "@sinclair/typebox"]);

/** 子路径导入映射回包名。 */
const SUBPATH_TO_PACKAGE = new Map([
	["typebox/compile", "typebox"],
	["typebox/value", "typebox"],
	["@sinclair/typebox/compile", "@sinclair/typebox"],
	["@sinclair/typebox/value", "@sinclair/typebox"],
]);

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IMPORT_PATTERNS = [
	/\bfrom\s*["']([^"']+)["']/g,
	/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
	/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		console.error(`无法解析 ${path}：${error.message}`);
		process.exit(1);
	}
};

/** 收集 workspace 中参与构建/运行的源码文件（index.ts + src/ 递归）。 */
function collectSourceFiles(workspaceDir) {
	const files = [];
	const indexPath = join(workspaceDir, "index.ts");
	if (existsSync(indexPath)) files.push(indexPath);
	const srcDir = join(workspaceDir, "src");
	if (!existsSync(srcDir)) return files;
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (SOURCE_EXTENSIONS.test(entry.name)) files.push(full);
		}
	};
	walk(srcDir);
	return files;
}

/** 源码中出现的宿主提供包（去重、排序）。 */
function collectHostImports(files) {
	const imported = new Set();
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		for (const pattern of IMPORT_PATTERNS) {
			for (const match of source.matchAll(pattern)) {
				const specifier = SUBPATH_TO_PACKAGE.get(match[1]) ?? match[1];
				if (HOST_PROVIDED_PACKAGES.has(specifier)) imported.add(specifier);
			}
		}
	}
	return [...imported].sort();
}

const rootPkg = readJson(join(repoRoot, "package.json"));
const problems = [];
let checkedCount = 0;

for (const workspace of rootPkg.workspaces ?? []) {
	const workspaceDir = join(repoRoot, workspace);
	if (!existsSync(workspaceDir)) continue;
	const pkg = readJson(join(workspaceDir, "package.json"));
	const label = pkg.name ?? workspace;
	const deps = pkg.dependencies ?? {};
	const peers = pkg.peerDependencies ?? {};
	checkedCount++;

	for (const name of Object.keys(deps).filter((name) => HOST_PROVIDED_PACKAGES.has(name)).sort()) {
		problems.push(
			`${label}: dependencies["${name}"] = "${deps[name]}"，宿主已提供该包。` +
				`请改为 peerDependencies["${name}"] = "*"（宿主会对此告警，且安装副本会造成重复运行时模块）`,
		);
	}

	for (const name of collectHostImports(collectSourceFiles(workspaceDir))) {
		const peerRange = peers[name];
		if (peerRange === undefined) {
			problems.push(`${label}: 源码 import 了宿主提供包 "${name}"，但未在 peerDependencies 中声明`);
			continue;
		}
		if (WILDCARD_RANGE_PACKAGES.has(name) && peerRange !== "*") {
			problems.push(
				`${label}: peerDependencies["${name}"] = "${peerRange}"，应为 "*"（宿主提供包按宿主约定使用 "*" 范围）`,
			);
		}
	}
}

if (problems.length > 0) {
	console.error("宿主提供包声明检查失败（规范：docs/guides/pi-package-spec.md）：");
	for (const problem of problems) console.error(`  - ${problem}`);
	console.error(`\n共 ${problems.length} 项问题。修复后运行 npm install 以同步 package-lock.json。`);
	process.exit(1);
}

console.log(`宿主提供包声明检查通过：${checkedCount} 个 workspace 均未把宿主提供包写入 dependencies，且 import 的宿主提供包均已在 peerDependencies 声明。`);
