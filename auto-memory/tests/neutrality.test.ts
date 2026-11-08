import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * core 的中立性门。
 *
 * `auto-memory` 是整个拆分的全部意义所在：它必须能被任何 harness 依赖，因此**不得**认识任何
 * 宿主。这道门用 import 说明符来判定，而不是靠 package.json 的依赖声明 —— monorepo 的 hoisting
 * 会让宿主的包在 `node_modules` 里看得见，「编译得过」拦不住一次顺手 import。
 *
 * 规则：
 * - `src/**` 只允许 `node:*` 与相对路径；
 * - `tests/**` 额外允许 `vitest`（测试框架不是宿主）。
 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 与 `scripts/check-host-deps.mjs` 同口径的四条 import 正则，外加裸的副作用 import
 * （`import "pkg";` 没有 `from`，前三条都看不见它，而它同样会把宿主运行时拉进来）。
 */
const IMPORT_PATTERNS = [
	/\bfrom\s*["']([^"']+)["']/g,
	/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
	/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
	/\bimport\s*["']([^"']+)["']/g,
];

const ALLOWED_IN_TESTS = new Set(["vitest"]);

/** 参与扫描的源码扩展名（与 `check-host-deps.mjs` 的 `SOURCE_EXTENSIONS` 一致）。 */
const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * 这道门自己的文件名，两个扫描都跳过它。
 *
 * 不是豁免：下面的「门本身的自检」必须把违规写法**逐字写在字符串里**才能证明扫描器报得出来，
 * 而扫描器是按文本匹配的、不认识字符串边界。用拼接把字面量藏起来只会让夹具读不懂。
 * 本文件自己的 import 只有 `node:*` 与 `vitest`，肉眼可核。
 */
const GATE_FILE_NAME = "neutrality.test.ts";

/**
 * 指向 pi-packages 仓库内部坐标的引用。core 是独立包，这些编号在那边才有意义：
 * 留着就是悬空指针，而且会让维护者以为某份文档就在手边。
 *
 * 刻意**不**禁 `pi-memory` 这个名字：明确写成「适配层的另一半钉在 pi-memory 的某个测试里」
 * 是有效的跨包指针，不是悬空引用。同理不禁 `@earendil-works/*` 出现在散文里 ——
 * `store/mutation-queue.ts` 必须点名 pi 的同名实现，否则「不得简化掉那三件语义」这条约束没有对照物。
 */
const DANGLING_REFERENCE_PATTERNS: Array<{ re: RegExp; why: string }> = [
	{ re: /§\s*\d/, why: "pi-packages 内部 spec 的章节号" },
	{ re: /\bD\d{1,2}\b/, why: "pi-packages 内部 spec 的决策编号" },
	{ re: /\bReview Focus #/, why: "pi-packages 内部计划/审阅的条目编号" },
	{ re: /\bRuling\b/, why: "pi-packages 内部 spec 的裁决编号" },
	{ re: /\bPlan [A-E]\b/, why: "pi-packages 内部实施计划的代号" },
	{ re: /\bFinding [A-Z]/, why: "pi-packages 内部审阅的编号" },
	{ re: /终审/, why: "pi-packages 内部审阅的轮次" },
	{ re: /\bledger\b/i, why: "pi-packages 内部执行台账" },
	// 前后两个断言排除掉标识符与路径：`memory-store` / `memoryDir` / `./store/memory-store.js` /
	// `"./memory"`（配置示例）都不是命令。要抓的是斜杠**命令**本身（`/memory`、`/memory unlock`）。
	{ re: /(?<![\w.\/-])\/memory(?![\w-])/, why: "宿主的斜杠命令；core 不注册任何命令" },
	{
		re: /\b(?:session_start|agent_end|before_agent_start|session_compact|session_shutdown)\b/,
		why: "宿主的事件名；core 只认端口",
	},
];

function isAllowed(specifier: string, extra: Set<string>): boolean {
	return (
		specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../") || extra.has(specifier)
	);
}

async function collectSourceFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true, recursive: true });
	return entries
		.filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.test(entry.name) && entry.name !== GATE_FILE_NAME)
		.map((entry) => join(entry.parentPath, entry.name));
}

/** 扫描一个目录，返回「文件:行 → 说明符」的违规清单（一次报完，不是只报第一个）。 */
async function scanImports(dir: string, extra: Set<string>): Promise<string[]> {
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

/** 扫描一个目录里指向 pi-packages 内部坐标的悬空引用。 */
async function scanDanglingReferences(dir: string): Promise<string[]> {
	const violations: string[] = [];
	for (const file of await collectSourceFiles(dir)) {
		const lines = (await readFile(file, "utf8")).split("\n");
		lines.forEach((line, index) => {
			for (const { re, why } of DANGLING_REFERENCE_PATTERNS) {
				if (re.test(line)) {
					violations.push(`${relative(PACKAGE_ROOT, file)}:${index + 1} → ${re.source}（${why}）`);
				}
			}
		});
	}
	return violations;
}

describe("neutrality: imports", () => {
	it("src/ imports nothing but node: builtins and relative paths", async () => {
		const violations = await scanImports(join(PACKAGE_ROOT, "src"), new Set());
		expect(violations, `core 必须零 harness 依赖：\n${violations.join("\n")}`).toEqual([]);
	});

	it("tests/ imports nothing but node: builtins, relative paths and vitest", async () => {
		const violations = await scanImports(join(PACKAGE_ROOT, "tests"), ALLOWED_IN_TESTS);
		expect(violations, `core 的测试不得把宿主包拖进来：\n${violations.join("\n")}`).toEqual([]);
	});
});

describe("neutrality: dangling references", () => {
	it("src/ and tests/ carry no pi-packages-internal coordinates", async () => {
		const violations = [
			...(await scanDanglingReferences(join(PACKAGE_ROOT, "src"))),
			...(await scanDanglingReferences(join(PACKAGE_ROOT, "tests"))),
		];
		expect(
			violations,
			`core 是独立包，注释里不得留下只有 pi-packages 才读得懂的坐标：\n${violations.join("\n")}`,
		).toEqual([]);
	});
});

/**
 * 门本身的自检：上面两条规则要能被违反，否则它们只是装饰。
 * 用临时目录造出真实的违规文件，断言扫描器报得出来。
 */
describe("neutrality: the gate detects violations", () => {
	let dir: string;

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function fixture(files: Record<string, string>): Promise<string> {
		dir = await mkdtemp(join(tmpdir(), "am-neutrality-"));
		for (const [name, body] of Object.entries(files)) {
			const full = join(dir, name);
			await writeFile(full, body, "utf8");
		}
		return dir;
	}

	it("reports a bare side-effect import of a host package", async () => {
		const root = await fixture({
			"a.ts": 'import "@earendil-works/pi-coding-agent";\nexport const a = 1;\n',
		});
		expect(await scanImports(root, new Set())).toEqual([`${relative(PACKAGE_ROOT, join(root, "a.ts"))}:1 → @earendil-works/pi-coding-agent`]);
	});

	it("reports dynamic import() and require() of a host package", async () => {
		const root = await fixture({
			"a.ts": 'const m = await import("typebox");\nconst n = require("@earendil-works/pi-tui");\n',
		});
		expect(await scanImports(root, new Set())).toHaveLength(2);
	});

	it("scans non-.ts sources too, so a stray .mjs cannot smuggle a host import in", async () => {
		const root = await fixture({
			"a.mjs": 'import { Type } from "typebox";\n',
			"b.cts": 'const x = require("@earendil-works/pi-ai");\n',
			"c.js": 'import "schemastery";\n',
		});
		expect(await scanImports(root, new Set())).toHaveLength(3);
	});

	it("allows node: builtins, relative paths, and vitest only under tests/", async () => {
		const root = await fixture({
			"ok.ts": 'import { join } from "node:path";\nimport { x } from "./sibling.ts";\nimport { describe } from "vitest";\n',
		});
		expect(await scanImports(root, ALLOWED_IN_TESTS)).toEqual([]);
		expect(await scanImports(root, new Set())).toHaveLength(1); // vitest 在 src/ 下不算豁免
	});

	it("reports every dangling-reference pattern with the file, line and reason", async () => {
		// 一行一条规则：命中数 = 行数 = 去重后的行集合，任何一条规则失效都会让这三个数对不上。
		const lines = [
			"// 见 spec §4.4 的中间态",
			"// Ruling 12 决定这样",
			"// Plan C 的产物",
			"// 终审时定的",
			"// Finding I2",
			"// 见 ledger",
			"// Review Focus #3",
			"// 决策 D11 明确鼓励手改",
			"// 跑 /memory unlock 清掉",
			"// 在 agent_end 时触发",
		];
		const root = await fixture({ "a.ts": lines.join("\n") });
		const violations = await scanDanglingReferences(root);
		expect(violations).toHaveLength(lines.length);
		// 报的是「文件:行」，路径相对包根 —— 夹具在 tmpdir 下，所以只比对末段。
		// 分隔符要同时认 `/` 与 `\`：Windows 上 `relative()` 产出的是反斜杠路径。
		expect(violations.map((v) => v.split(" → ")[0].split(/[/\\]/).pop())).toEqual(
			lines.map((_, i) => `a.ts:${i + 1}`),
		);
		for (const v of violations) expect(v).toMatch(/（.+）$/); // 每条都带上「为什么算悬空」
	});

	it("does not flag a cross-package pointer, a prose mention of the host, or an ordinary path", async () => {
		const root = await fixture({
			"a.ts": [
				"// 适配层的另一半钉在 pi-memory/tests/config-paths.test.ts",
				"// 语义与 pi 的 withFileMutationQueue（@earendil-works/pi-coding-agent）逐条一致",
				"// 记忆根是 $XDG_DATA_HOME/auto-memory，不是任何宿主的目录",
				'// 相对路径配置（如 `"./memory"`）会固化成绝对路径',
				'import { MemoryStore } from "./store/memory-store.js";',
				"// memoryDir 与 MEMORY.md 都是本包自己的名字",
			].join("\n"),
		});
		expect(await scanDanglingReferences(root)).toEqual([]);
	});
});
