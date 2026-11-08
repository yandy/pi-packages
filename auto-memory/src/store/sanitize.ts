/**
 * 注入净化（spec §13）。**只在注入时**使用，绝不写回磁盘（D11）—— 磁盘上的 entry 必须
 * 保持用户可读、可手工编辑的原始形态。
 *
 * 本模块是纯函数模块：不 import `node:fs`、不读配置、不碰 store。
 */

/**
 * 全部 Unicode `Cf`（format）类别字符：零宽（U+200B–U+200D、U+FEFF）、bidi 控制符
 * （U+202A–U+202E、U+2066–U+2069）、软连字符、LRM/RLM、word joiner 等。
 *
 * 用 `\p{Cf}` 而不是逐个码点枚举：新加入的格式字符自动被覆盖。`\n` / `\t` 是 Cc、
 * 空格是 Zs，都不在此列 —— 注入文本的排版必须原样保留。
 */
const INVISIBLE_RE = /\p{Cf}/gu;

/** 剥离全部不可见格式字符（bidi 覆写可以让磁盘上的记忆在注入后"读出"别的意思）。 */
export function stripInvisibleChars(text: string): string {
	return text.replace(INVISIBLE_RE, "");
}

/**
 * 净化一段将要进入 system prompt / 注入消息的文本：剥离不可见字符 + 中和尖括号。
 *
 * **幂等是硬要求，所以这里刻意不转义 `&`。** 若把 `&` → `&amp;`，第一次产出的 `&lt;`
 * 在第二次就会变成 `&amp;lt;`；而 `memory_index` 的值在 resume / fork / reload 时会被
 * 逐轮重放（D13 / D14），每重放一次就漂移一次 —— system prompt 头部再也稳定不下来，
 * prefix cache 全废。`sanitizeForInjection(sanitizeForInjection(x)) === sanitizeForInjection(x)`
 * 由测试钉住。
 *
 * 代价：正文里字面的 `&lt;` 在注入后无法与「原本是 `<`」区分。这是可接受的取舍 ——
 * 两者在模型眼里都读作 `<`，而我们要防的正是「用 `<` 伪造系统标签」。
 */
export function sanitizeForInjection(text: string): string {
	return stripInvisibleChars(text).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
