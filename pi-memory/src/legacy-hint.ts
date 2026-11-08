import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectDirName, projectIdentity } from "@yandy0725/auto-memory";

/**
 * 2.x → 3.0 的数据根迁移提示。
 *
 * 3.0 把共享数据根从 `~/.pi/memory/` 搬到了 `$XDG_DATA_HOME/auto-memory`（默认
 * `~/.local/share/auto-memory`），好让别的宿主能读同一批文件。**不自动迁移**：静默搬动用户
 * 数据比提示更危险（两个宿主同时启动、mv 中途失败、`.lock`/`.backups` 被一起搬走都要额外处理）。
 *
 * 这条逻辑住在 pi 适配层而不是 core —— core 对 `.pi` 一无所知。
 */
export interface LegacyHintOpts {
	/** 已解析的本项目记忆目录（3.0 的落点）。 */
	newDir: string;
	/** 3.0 的数据根（`defaultMemoryRoot()`），用来拼迁移命令。 */
	newRoot: string;
	/** 2.x 的数据根（pi 的 `~/.pi/memory`）。 */
	legacyRoot: string;
	cwd: string;
	/** 命名规则跟随的平台。默认 `process.platform`。 */
	platform?: NodeJS.Platform;
}

/**
 * 旧目录里有本项目的记忆、而新目录还不存在时，返回一段可直接照抄的提示；否则返回 `null`。
 *
 * **只用 `existsSync`**：不 mkdir、不碰 `MemoryStore`（store 的写入路径会 `mkdir`），
 * 因此探测本身不可能在磁盘上留下痕迹。新目录已存在时立刻返回 —— 迁移完成后不该再唠叨。
 */
export async function detectLegacyMemoryDir(opts: LegacyHintOpts): Promise<string | null> {
	if (existsSync(opts.newDir)) return null;
	const { kind, key } = await projectIdentity(opts.cwd, opts.platform);
	const legacyDir = join(opts.legacyRoot, kind, projectDirName(key, { platform: opts.platform }));
	if (!existsSync(legacyDir)) return null;
	return [
		`Note: found pre-3.0 memories at ${legacyDir}. Move them with:`,
		`  mkdir -p ${dirname(opts.newRoot)} && mv ${opts.legacyRoot} ${opts.newRoot}`,
	].join("\n");
}
