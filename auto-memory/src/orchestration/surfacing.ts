import type { SessionPersistenceConfig } from "../config.js";
import type { EntryManifest } from "../injection.js";
import { buildSideQueryTask } from "../injection.js";
import type { HeadlessAgentPort } from "./ports.js";

export interface RunSideQueryOpts {
	/** 本轮的候选清单（`scanEntries` 的产出）。 */
	manifest: EntryManifest[];
	/** 用户这一轮的输入（调用方负责先截到预算内）。 */
	userPrompt: string;
	/** 本 session 已经注入过的文件，不再重复选。 */
	injectedFiles: Set<string>;
	maxFiles: number;
	/** 宿主的思考/推理档位，core 原样透传。 */
	effort?: string;
	model: string;
	/** 子会话 cwd；传 memoryDir。 */
	cwd: string;
	sessionPersistence?: SessionPersistenceConfig;
}

/** 从侧查询的回复里解析 `selected_files`，只保留确实在候选清单里的文件。 */
function parseSelectedFiles(result: string, candidates: EntryManifest[], maxFiles: number): string[] {
	try {
		const jsonMatch = result.match(/\{[^}]*"selected_files"[^}]*\}/s);
		if (!jsonMatch) return [];
		const parsed = JSON.parse(jsonMatch[0]);
		const files: string[] = parsed.selected_files ?? [];
		return files.filter((f: string) => candidates.some((c) => c.file === f)).slice(0, maxFiles);
	} catch {
		return [];
	}
}

/**
 * 跑一轮轻量侧查询，选出与用户输入相关的 entry 文件名。
 *
 * 超时/失败一律返回 `[]`，**没有回退**：auto-surfacing 是纯增益，选不出来就不注入，
 * 绝不因为侧查询挂了而打断用户这一轮。
 *
 * 返回的是**文件名**，不是注入内容 —— 「注入到哪个通道、本 session 已注入过哪些」是适配层的事。
 */
export async function runSideQuery(
	opts: RunSideQueryOpts,
	ports: { headless: HeadlessAgentPort },
): Promise<string[]> {
	const candidates = opts.manifest.filter((entry) => !opts.injectedFiles.has(entry.file));
	if (candidates.length === 0) return [];
	const task = buildSideQueryTask(candidates, opts.userPrompt, opts.maxFiles);
	try {
		const result = await ports.headless.run({
			task,
			cwd: opts.cwd,
			model: opts.model,
			effort: opts.effort,
			maxTurns: 1,
			timeoutMs: 30_000,
			// 零工具就是意图：侧查询只需要回一个 JSON，给它任何工具都是白烧 token。
			builtinTools: "none",
			memoryTool: null,
			sessionPersistence: opts.sessionPersistence,
		});
		if (result === null) return [];
		return parseSelectedFiles(result, candidates, opts.maxFiles);
	} catch {
		return [];
	}
}
