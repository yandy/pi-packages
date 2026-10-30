/**
 * ast_grep_search / ast_grep_replace 共用的参数文案。
 *
 * 两个工具的 `pattern` 与 `lang` 语义完全相同。此前这些字符串在两个文件里各手写一份
 * （共 402 字符逐字重复），措辞一旦漂移就会让模型对同一参数看到两种说法；抽成常量后
 * 改一处即两处生效（spec 2026-10-30 §3 R6）。
 */

export const AST_PATTERN_DESCRIPTION =
	"AST pattern with $VAR (single node) and $$$ (zero-or-more nodes). NOT regex. Must be a complete AST node.";

/**
 * `lang` 的兜底行为必须写出来：`inferLangFromPath` 只看扩展名，传目录（`src/`）或
 * 无扩展名路径时推断失败，工具会**静默按 typescript 搜**——不写这句话，模型会以为
 * 「省略即自动识别整个仓库的语言」。
 */
export const AST_LANG_DESCRIPTION =
	"Language: typescript/tsx/javascript/python/java/kotlin/c/cpp. Inferred from the path extension; when the path has no usable extension this falls back to typescript, so pass lang explicitly for directories.";
