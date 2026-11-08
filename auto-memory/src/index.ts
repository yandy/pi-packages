/**
 * `@yandy0725/auto-memory` 的公开 API 唯一入口。
 *
 * 子路径不导出：适配层只能从这里拿符号，这样「什么是契约」永远等于这一个文件的内容
 * （spec §10：1.0.0 只导出适配层实际用到的符号）。
 *
 * 中立性硬约束：本包的任何文件都不得 import 宿主包（`@earendil-works/*`、`typebox`、
 * `@earendil-works/pi-tui`、`schemastery`）。`tests/neutrality.test.ts` 是这条约束的执行点。
 */

// store/ —— 并发
export { withFileMutationQueue } from "./store/mutation-queue";
