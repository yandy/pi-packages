import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * core 的中立性门（spec §9.1 / Global Constraints）。
 *
 * `auto-memory` 是整个拆分的全部意义所在：它必须能被任何 harness 依赖，因此**不得**认识任何
 * 宿主。这道门用 import 说明符来判定，而不是靠 package.json 的依赖声明——monorepo 的 hoisting
 * 会让宿主的包在 `node_modules` 里看得见，「编译得过」拦不住一次顺手 import。
 *
 * 规则：
 * - `src/**` 只允许 `node:*` 与相对路径；
 * - `tests/**` 额外允许 `vitest`（测试框架不是宿主）。
 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 `scripts/check-host-deps.mjs` 逐字一致的三条 import 正则。 */
const IMPORT_PATTERNS = [
	/\bfrom\s*["']([^"']+)["']/g,
	/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
	/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

const ALLOWED_IN_TESTS = new Set(["vitest"]);

function isAllowed(specifier: string, extra: Set<string>): boolean {
	return specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../") || extra.has(specifier);
}

async function collectSourceFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true, recursive: true });
	return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts")).map((entry) => join(entry.parentPath, entry.name));
}

/** 扫描一个目录，返回「文件:行 → 说明符」的违规清单（一次报完，不是只报第一个）。 */
async function scan(dir: string, extra: Set<string>): Promise<string[]> {
	const violations: string[] = [];
	for (const file of await collectSourceFiles(dir)) {
		const lines = (await readFile(file, "utf8")).split("\n");
		lines.forEach((line, index) => {
			for (const pattern of IMPORT_PATTERNS) {
				pattern.lastIndex = 0;
				for (const match of line.matchAll(pattern)) {
					const specifier = match[1];
					if (!isAllowed(specifier, extra)) {
						violations.push(`${relative(PACKAGE_ROOT, file)}:${index + 1} → ${specifier}`);
					}
				}
			}
		});
	}
	return violations;
}

describe("neutrality", () => {
	it("src/ imports nothing but node: builtins and relative paths", async () => {
		const violations = await scan(join(PACKAGE_ROOT, "src"), new Set());
		expect(violations, `core 必须零 harness 依赖：\n${violations.join("\n")}`).toEqual([]);
	});

	it("tests/ imports nothing but node: builtins, relative paths and vitest", async () => {
		const violations = await scan(join(PACKAGE_ROOT, "tests"), ALLOWED_IN_TESTS);
		expect(violations, `core 的测试不得把宿主包拖进来：\n${violations.join("\n")}`).toEqual([]);
	});
});
