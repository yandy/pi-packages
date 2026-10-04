import { fileURLToPath } from "node:url";

/** 诊断技能目录的绝对路径。相对路径不可用：pi 把 `resources_discover` 返回的路径按**会话 cwd**
 *  解析（`resolveResourcePath(p) = resolvePath(p, cwd)`），`baseDir` 只进来源标注——见 spec §4.10
 *  的真机证据。
 *  技能必须位于非约定目录 `resources/skills/`（否则会被 pi 的包自动发现加载到所有平台，spec §4.10）。 */
const ACL_SKILL_DIR = fileURLToPath(new URL("../../resources/skills/diagnose-windows-sandbox-acl", import.meta.url));

/**
 * 诊断技能的平台门控（spec Ruling 9）：只在 Windows 上把技能目录交给 pi。
 * 返回**追加**路径，绝不返回完整集合——pi 侧是合并语义
 * （`resource-loader.js` 的 `mergePaths(lastSkillPaths, …)`）：空数组 = 什么也不加，
 * 不会抹掉默认技能目录或其他扩展贡献的技能。
 */
export function aclSkillPaths(platform: string = process.platform): string[] {
	return platform === "win32" ? [ACL_SKILL_DIR] : [];
}
