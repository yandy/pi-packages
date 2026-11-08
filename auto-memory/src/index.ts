/**
 * `@yandy0725/auto-memory` 的公开 API 唯一入口。
 *
 * 子路径不导出：适配层只能从这里拿符号，这样「什么是契约」永远等于这一个文件的内容
 * （spec §10：1.0.0 只导出适配层实际用到的符号）。
 *
 * 中立性硬约束：本包的任何文件都不得 import 宿主包。`tests/neutrality.test.ts` 是这条约束的
 * 执行点 —— 它按 import 说明符判定，`src/**` 只允许 `node:*` 与相对路径。monorepo 的 hoisting
 * 会让宿主的包在 `node_modules` 里看得见，「编译得过」拦不住一次顺手 import，所以必须有这道门。
 */

// ── store/ 磁盘格式 ────────────────────────────────────────────────────────────
export { ENTRY_TYPES, deriveDescription, parseEntryFile, serializeEntryFile } from "./store/entry-file";
export type { EntryMeta, EntryType, ParsedEntryFile } from "./store/entry-file";

export {
	formatIndexLine,
	indexCapacity,
	parseEntryIndex,
	removeIndexLine,
	splitLines,
	upsertIndexLine,
} from "./store/entry-index";
export type { IndexCapacity, IndexLineEntry, ParsedEntryIndex } from "./store/entry-index";

export { ENTRY_EXT, entryFileName, resolveUniqueFileName } from "./store/filename";

// ── store/ 读写门面 ────────────────────────────────────────────────────────────
export { BACKUP_DIR, LOCK_FILE, MemoryStore } from "./store/memory-store";
export type { Entry, EntrySummary, StoreConfig, WriteOptions } from "./store/memory-store";

// ── store/ 并发与容错 ──────────────────────────────────────────────────────────
export { MemoryLockedError, readLockStatus, tryWithLock, withLock } from "./store/fs-lock";
export type { LockInfo, LockOptions } from "./store/fs-lock";

export { isTransientFsError, withFsRetry } from "./store/fs-retry";
export type { FsRetryOptions } from "./store/fs-retry";

export { ProcessLockTimeoutError, isProcessLockActive, tryWithProcessLock, withProcessLock } from "./store/process-lock";

export { createSnapshot, pruneSnapshots, snapshotStamp } from "./store/snapshot";
export type { SnapshotOptions } from "./store/snapshot";

export { withFileMutationQueue } from "./store/mutation-queue";

// ── store/ 路径与安全 ──────────────────────────────────────────────────────────
export { assertInsideRoot, normalizeRemoteUrl, projectDirName, projectIdentity, resolveMemoryDir } from "./store/paths";
export type { NamingOptions, ProjectIdentity, ProjectKind } from "./store/paths";

export { sanitizeForInjection, stripInvisibleChars } from "./store/sanitize";

export { escapeWindowsTrailing, isReservedWindowsName, windowsSafeName } from "./store/windows-names";

// ── 配置（默认值、合并语义、模型校验、共享数据根）──────────────────────────────
// 配置文件**在哪**是宿主知识，由适配层组装成 `loadConfigFrom` 的 `files` 入参。
export {
	DEFAULT_CONFIG,
	defaultMemoryRoot,
	expandTilde,
	loadConfigFrom,
	modelConfigErrors,
	requiredModel,
	requiredModels,
	taskModel,
} from "./config";
export type {
	AutoSurfacingConfig,
	DefaultsConfig,
	ExtractMemoriesConfig,
	LoadConfigFromOptions,
	MemoryConfig,
	ModelTask,
	SessionPersistenceConfig,
	ThinkLevel,
} from "./config";
