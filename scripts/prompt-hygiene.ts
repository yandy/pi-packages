import { expect } from "vitest";

/**
 * 工具提示词卫生闸门（spec 2026-10-30 §3 / §7）。
 *
 * 三个通道的性质不同，规则也不同：
 * - `description`：工具 schema，每请求 × 每工具各一份 → 只写事实，不复述参数、不写纪律；
 * - `promptSnippet`：system prompt 的 `Available tools` 目录行，宿主渲染成 `- <name>: <snippet>`
 *   （`dist/core/system-prompt.js`），所以**不能再写工具名**、不写指令、不加句号；
 * - `promptGuidelines`：system prompt 的 `Guidelines`，按**精确字符串**去重 → 跨工具共享的规则
 *   必须来自同一常量，且不得与本工具 description 逐字重复。
 *
 * 只对 `authored` 列出的工具做措辞检查：本仓的 pi-sandbox / pi-container-sandbox 会重新注册
 * pi 内置的 read/write/edit/bash，那些 snippet 是 pi 自己写的（例如 edit 的 98 字符 snippet
 * 以 "Make" 开头），不该由本仓的规则去约束；预算仍然对整包生效。
 */

export interface PromptTool {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
}

export interface PromptHygieneOptions {
	/** 包名，仅用于失败信息 */
	pkg: string;
	/** 三通道合计字符上限（spec §10 的「改后上限」） */
	budget: number;
	/** 该包注册的全部工具 */
	tools: PromptTool[];
	/** 本包自己撰写提示词的工具体；内置工具的继承文案不参与措辞检查 */
	authored: string[];
}

/** pi 内置 snippet 最长 98 字符（edit），本仓新增的一律不超过 100。 */
const SNIPPET_MAX = 100;
const GUIDELINE_MAX = 700;

/** 目录行以指令开头 = 把 guideline 写进了目录（R3）。 */
const IMPERATIVE_START = /^(Use|Do not|Don't|Always|Never|Make|Set|Call|Prefer|Consider)\b/;

function channels(tool: PromptTool) {
	const guidelines = tool.promptGuidelines ?? [];
	return {
		Snippet: tool.promptSnippet ?? "",
		description: tool.description ?? "",
		guidelines,
		params: JSON.stringify(tool.parameters ?? {}),
		guidelinesText: guidelines.join(" "),
	};
}

export function assertPromptHygiene(options: PromptHygieneOptions): void {
	const { pkg, budget, tools, authored } = options;
	const authoredSet = new Set(authored);

	for (const tool of tools) {
		const c = channels(tool);
		const label = `${pkg}/${tool.name}`;

		if (authoredSet.has(tool.name)) {
			expect(c.Snippet.length, `${label}: promptSnippet 缺失`).toBeGreaterThan(0);
			expect(c.Snippet.length, `${label}: snippet 超过 ${SNIPPET_MAX} 字符`).toBeLessThanOrEqual(SNIPPET_MAX);
			// 宿主已渲染 `- <name>: `，snippet 再写一遍工具名会显示成「websearch: websearch: …」
			expect(
				c.Snippet.toLowerCase().startsWith(`${tool.name.toLowerCase()}:`),
				`${label}: snippet 重复了工具名`,
			).toBe(false);
			expect(c.Snippet.endsWith("."), `${label}: 目录行不该以句号结尾`).toBe(false);
			expect(IMPERATIVE_START.test(c.Snippet), `${label}: 目录行不该是指令`).toBe(false);
		}

		for (const guideline of c.guidelines) {
			expect(guideline.length, `${label}: 单条 guideline 超过 ${GUIDELINE_MAX} 字符`).toBeLessThanOrEqual(GUIDELINE_MAX);
			expect(guideline.trim().length, `${label}: 空 guideline`).toBeGreaterThan(0);
			// R5：同一句话不许同时出现在 description 与 guidelines（各付一份，且会把两处绑死）
			expect(c.description.includes(guideline.trim()), `${label}: guideline 与 description 逐字重复`).toBe(false);
		}

		// R6：包内同一工具的 guideline 不该自己跟自己重复
		expect(new Set(c.guidelines).size, `${label}: 包内 guideline 有完全重复项`).toBe(c.guidelines.length);
	}

	// 预算按**实际进 prompt 的量**计：pi 按精确字符串去重 guidelines（`agent-session.js` 的
	// `_normalizePromptGuidelines`），所以跨工具共享的同一条规则只付一次。不这样算，会把
	// pi-sandbox 那两条写进 3 个工具的规则的代价高估 2 倍。
	const uniqueGuidelines = new Set<string>();
	for (const tool of tools) for (const g of tool.promptGuidelines ?? []) uniqueGuidelines.add(g.trim());
	const total =
		tools.reduce((sum, tool) => {
			const c = channels(tool);
			return sum + c.Snippet.length + c.description.length + c.params.length;
		}, 0) + [...uniqueGuidelines].join(" ").length;
	expect(total, `${pkg}: 三通道合计 ${total} 超过预算 ${budget}（spec 2026-10-30 §10）`).toBeLessThanOrEqual(budget);
}
