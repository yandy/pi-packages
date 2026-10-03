/**
 * 诊断技能的平台门控（spec Ruling 9）：只在 Windows 上把技能目录交给 pi。
 * 返回**追加**路径，绝不返回完整集合——pi 侧是合并语义
 * （`resource-loader.js` 的 `mergePaths(lastSkillPaths, …)`）：空数组 = 什么也不加，
 * 不会抹掉默认技能目录或其他扩展贡献的技能。
 */
export function aclSkillPaths(platform: string = process.platform): string[] {
	return platform === "win32" ? ["./skills/diagnose-windows-sandbox-acl"] : [];
}
