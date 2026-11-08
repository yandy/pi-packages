import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	type EntryManifest,
	type MemoryStore,
	buildSideQueryTask,
	renderSurfacedBlock,
} from "@yandy0725/auto-memory";
import { runHeadlessAgent } from "./agent-runner";
import type { SessionPersistenceConfig, ThinkLevel } from "./config";
import { MEMORY_INDEX_SECTION } from "./index-source";

/**
 * pi 专属的注入**机制**。
 *
 * 「算出该注入什么字符串」是纯策略，住在 core 的 `injection.ts`；这里只剩三件必须认识 pi 的事：
 * 往 `event.systemPrompt` 上拼、往 `event.systemPromptOptions.sections` 里写、以及把 surfaced
 * 内容交给宿主的注入通道。注入时机、session 内的去重状态、以及为 prompt cache 服务的
 * 「索引按 session 冻结 + resume/fork 重放录制值」（`index-source.ts`）也都在 pi 这一侧。
 */

export function buildInjection(systemPrompt: string, snapshot: string): string {
	if (!snapshot) return systemPrompt;
	return `${systemPrompt}\n\n${snapshot}`;
}

/**
 * 把冻结的索引值写进 `event.systemPromptOptions.sections`（就地修改这个可变对象）。
 *
 * 返回 `false` 表示宿主 SDK 太旧、没有 `sections`（本地类型是 0.80.2），调用方必须回退
 * `{ systemPrompt: buildInjection(…) }`（功能不受损，只是缓存变差）。
 *
 * **无条件设置**，哪怕值是 `""`：省略这个键等于告诉 pi「该 section 不应存在」，
 * `diffSystemPromptSections` 会生成 `{ memory_index: null }`，索引被从 system prompt 里
 * **静默删除**。「不想改」只能靠喂回逐字节相同的值实现。
 */
export function applyIndexSection(systemPromptOptions: unknown, value: string): boolean {
	const options = systemPromptOptions as { sections?: unknown } | null | undefined;
	const sections = options?.sections;
	if (typeof sections !== "object" || sections === null) return false;
	(sections as Record<string, string | null>)[MEMORY_INDEX_SECTION] = value;
	return true;
}

/** core 渲染出 `<relevant_memories>` 块，pi 只负责把它交出去（空串 = 本轮不注入）。 */
export async function injectSurfacedContent(
	store: MemoryStore,
	selectedFiles: string[],
	maxEntryBytes: number,
	maxInjectionBytes: number,
): Promise<string> {
	return renderSurfacedBlock(store, selectedFiles, maxEntryBytes, maxInjectionBytes);
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

/** Run a lightweight headless side-query to select relevant entry files.
 *  Returns [] on timeout/failure — no fallback. */
export async function runSideQuery(
	manifest: EntryManifest[],
	userPrompt: string,
	injectedFiles: Set<string>,
	maxFiles: number,
	thinkLevel: ThinkLevel,
	model: string,
	modelRegistry: ModelRegistry,
	memoryDir: string,
	sessionPersistence?: SessionPersistenceConfig,
): Promise<string[]> {
	const candidates = manifest.filter((entry) => !injectedFiles.has(entry.file));
	if (candidates.length === 0) return [];
	const task = buildSideQueryTask(candidates, userPrompt, maxFiles);
	try {
		const result = await runHeadlessAgent({
			task,
			cwd: memoryDir,
			modelRegistry,
			model,
			thinkLevel,
			maxTurns: 1,
			timeoutMs: 30_000,
			// 侧查询没有任何 customTools，零工具就是意图：tools: []（白名单）把 builtin 也关掉。
			// 若以后要给它加 customTools，必须改成 noTools: "builtin"（见 agent-runner.ts 的警告）。
			tools: [],
			sessionPersistence,
		});
		return parseSelectedFiles(result, candidates, maxFiles);
	} catch {
		return [];
	}
}
