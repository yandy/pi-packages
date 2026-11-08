import { MEMORY_INDEX_SECTION } from "./index-source";

/**
 * pi 专属的注入**机制**。
 *
 * 「算出该注入什么字符串」是纯策略，住在 core 的 `injection.ts`；这里只剩两件必须认识 pi 的事：
 * 往 `event.systemPrompt` 上拼、往 `event.systemPromptOptions.sections` 里写。
 * 注入时机、session 内的去重状态、以及为 prompt cache 服务的
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
