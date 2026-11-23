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
import { dirname, join, relative, resolve } from "node:path";
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

/**
 * 宿主扩展加载器按模块 ID 精确匹配注入宿主模块（pi-coding-agent 的
 * `dist/core/extensions/virtual-modules.js`）：除包根外只认下面这些子路径。
 * 其它子路径在 `pi install` 安装出来的扩展里解析不到（宿主 node_modules 不在扩展的
 * 解析链上），启动时报 `Cannot find module`；开发树里因为 node_modules 里躺着真实包，
 * 测试和类型检查都发现不了。新增子路径前先确认宿主 VIRTUAL_MODULES 里确实有。
 */
const ALLOWED_HOST_SUBPATHS = new Map([
	["@earendil-works/pi-ai", new Set(["compat", "models", "oauth", "providers/all"])],
	["@mariozechner/pi-ai", new Set(["compat", "models", "oauth", "providers/all"])],
	["typebox", new Set(["compile", "value"])],
	["@sinclair/typebox", new Set(["compile", "value"])],
]);

/** 宿主提供包中允许被扩展 import 的子路径；没有条目的包只允许 import 包根。 */
function describeAllowedSubpaths(packageName) {
	const subpaths = ALLOWED_HOST_SUBPATHS.get(packageName);
	return subpaths === undefined ? "包根" : `包根与 ${[...subpaths].map((subpath) => `${packageName}/${subpath}`).join("、")}`;
}

/** 源码中出现的宿主提供包子路径导入（`包名/子路径`，且不在白名单内）。 */
function collectHostSubpathImports(files) {
	const found = [];
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		for (const pattern of IMPORT_PATTERNS) {
			for (const match of source.matchAll(pattern)) {
				const specifier = match[1];
				const slash = specifier.indexOf("/");
				if (slash === -1) continue;
				// scoped 包名含两个 `/`，切分时保留 `@scope/name`。
				const splitAt = specifier.startsWith("@") ? specifier.indexOf("/", slash + 1) : slash;
				if (splitAt === -1) continue;
				const packageName = specifier.slice(0, splitAt);
				if (!HOST_PROVIDED_PACKAGES.has(packageName)) continue;
				const subpath = specifier.slice(splitAt + 1);
				if (ALLOWED_HOST_SUBPATHS.get(packageName)?.has(subpath)) continue;
				found.push({ file, specifier, packageName });
			}
		}
	}
	return found;
}

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

	const sourceFiles = collectSourceFiles(workspaceDir);

	for (const { file, specifier, packageName } of collectHostSubpathImports(sourceFiles)) {
		problems.push(
			`${label}: ${relative(repoRoot, file)} import 了宿主提供包的未映射子路径 "${specifier}"` +
				`（宿主只注入 ${describeAllowedSubpaths(packageName)}，安装后启动会报 Cannot find module）。` +
				"改为从包根 import，或把需要的实现放进本包源码",
		);
	}

	for (const name of collectHostImports(sourceFiles)) {
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

console.log(
	`宿主提供包检查通过：${checkedCount} 个 workspace 均未把宿主提供包写入 dependencies，import 的宿主提供包均已在 peerDependencies 声明，` +
		"且没有 import 宿主未映射的子路径。",
);
