import { ENTRY_TYPES } from "../store/entry-file.js";
import type { MemoryAction } from "./actions.js";

/** 一个参数的 JSON Schema 片段。所有参数都是字符串（可带枚举）。 */
export interface MemoryToolField {
	type: "string";
	enum?: readonly string[];
	description: string;
}

/**
 * `memory` 工具的参数 schema，纯 JSON Schema。
 *
 * 键序 `type` → `required` → `properties` 与 typebox `Type.Object` 的 JSON 输出一致：适配层
 * 转换后必须与这里逐字相等（适配层要有一条 JSON 往返相等的用例钉住它），
 * 所以模型看到的线格式在拆分前后不变。
 */
export interface MemoryToolJsonSchema {
	type: "object";
	required: string[];
	properties: Record<string, MemoryToolField>;
}

/**
 * 参数 schema 由 `actions` **动态构建**：不在集合里的 action 不出现在枚举里，`new_name` 也只在
 * 含 `rename` 的 schema（= dream）里存在。这是「注册范围是硬约束」的执行点。
 *
 * `type` 的枚举复用 `store/entry-file` 的 `ENTRY_TYPES`：磁盘上认哪些 type，schema 就只给哪些，
 * 两处不可能漂移。
 */
export function memoryToolSchema(actions: readonly MemoryAction[]): MemoryToolJsonSchema {
	const properties: Record<string, MemoryToolField> = {
		action: { type: "string", enum: [...actions], description: "Which memory operation to perform." },
		name: {
			type: "string",
			description:
				"Unique, human-readable title of the memory. Required for add; the lookup key for replace/remove/rename.",
		},
		description: {
			type: "string",
			description:
				"One self-contained line; future sessions select memories from it. Defaults to the first sentence of content.",
		},
		type: { type: "string", enum: [...ENTRY_TYPES], description: "Memory type. Defaults to feedback." },
		content: {
			type: "string",
			description: "The memory body. Required for add and replace; it becomes the whole entry file.",
		},
		query: { type: "string", description: "Search text (search)." },
		scope: {
			type: "string",
			enum: ["memory", "sessions"],
			description: "search target: memory entries (default) or past sessions.",
		},
	};
	if (actions.includes("rename")) {
		properties.new_name = {
			type: "string",
			description: "New unique title for the memory (rename). Its file name and index line follow.",
		};
	}
	return { type: "object", required: ["action"], properties };
}
