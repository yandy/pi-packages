/**
 * Windows 名字的两条硬规则。目录名（`paths.ts`）与 entry 文件名（`filename.ts`）共用。
 *
 * 为什么需要（spec §1.2 P2/P6）：
 * - Windows 把一组「保留设备名」当设备：`NUL`、`CON`、`COM1`…；**带扩展名也一样**
 *   （`NUL.txt`、`NUL.tar.gz` 都等价于 `NUL`），判定基准是「第一个 `.` 之前的部分」。
 *   用这些名字创建文件得不到文件：写入落到设备上（`con.md` 写进控制台），而索引里
 *   已经多了一行 —— 表现为静默丢记忆。
 * - Windows 静默剥掉结尾的 `.` 与空格：`proj.` 与 `proj ` 都是 `proj`，
 *   于是两个不同的 key 会撞进同一个目录。
 *
 * 两条规则**全平台生效**：git 类记忆目录跨机共享，名字必须在两边都安全（spec Ruling 5）。
 */

/** 保留设备名（大小写不敏感）。MS 文档的经典集合 + 控制台别名。 */
const RESERVED_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i;

/** 判定基准是**第一个 `.` 之前的部分**：`NUL.tar.gz` 等价于 `NUL`。 */
export function isReservedWindowsName(name: string): boolean {
	const dot = name.indexOf(".");
	return RESERVED_BASE.test(dot === -1 ? name : name.slice(0, dot));
}

/** 结尾的 `.` / 空格 → `_2e` / `_20`（沿用 `escapeSegment` 的 `_XX` 十六进制词汇表）。 */
export function escapeWindowsTrailing(name: string): string {
	const last = name[name.length - 1];
	if (last === ".") return `${name.slice(0, -1)}_2e`;
	if (last === " ") return `${name.slice(0, -1)}_20`;
	return name;
}

/**
 * 把名字收尾成 Windows 可安全使用的形态。
 * 顺序固定：先转义结尾点/空格、再判保留名（固定只为确定性；两种顺序都安全）。
 */
export function windowsSafeName(name: string): string {
	const escaped = escapeWindowsTrailing(name);
	return isReservedWindowsName(escaped) ? `_${escaped}` : escaped;
}
