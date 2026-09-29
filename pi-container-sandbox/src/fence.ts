import { realpathSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { escalationHintMarker, sandboxDenialMarker } from "./escalation";
import { writableRoots, type SandboxMode } from "./policy";

/** fs 写围栏拒绝：message 携带模型可见的双行标记（spec §7）。 */
export class FenceDenialError extends Error {
	constructor(path: string, mode: SandboxMode) {
		super(`${sandboxDenialMarker(mode)}\n${escalationHintMarker("operation")}\npath: ${path}`);
		this.name = "FenceDenialError";
	}
}

/**
 * 写目标的 canonical 化：解析**最深已存在祖先**的 symlink，保留不存在的尾部拼写。
 * 直接 realpath 整条路径会对尚不存在的写目标失败；不解析祖先则会被
 * ws/link → /etc 式 symlink 逃逸（词法前缀命中 ws/ 但实际落在围栏外）。
 */
export function canonicalizeTarget(path: string): string {
	let current = resolvePath(path);
	const tail: string[] = [];
	for (;;) {
		try {
			const real = realpathSync.native(current);
			return tail.length === 0 ? real : join(real, ...tail.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolvePath(path); // 连根都不可解析：保留词法拼写（保守，匹配不到任何授予根以外的东西）
			tail.push(basename(current));
			current = parent;
		}
	}
}

function sameIdentity(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

/**
 * containment 判定（deepseek dsh-fs-sandbox 语义）：词法快路径处理常规 canonical
 * 拼写；拼写不一致时沿 target 的存在祖先向上 walk，用文件系统身份（dev+ino）
 * 与授予根比较——容忍 missing 后缀，防祖先 symlink 换绑逃逸。
 */
export function isWithinRoots(target: string, roots: readonly string[]): boolean {
	for (const root of roots) {
		if (target === root || target.startsWith(`${root}/`)) return true;
	}
	for (const root of roots) {
		let rootInfo: Stats;
		try {
			rootInfo = statSync(root);
		} catch {
			continue; // 授予根不存在：匹配不到任何东西
		}
		let ancestor = target;
		for (;;) {
			let info: Stats | undefined;
			try {
				info = statSync(ancestor);
			} catch {
				info = undefined;
			}
			if (info && sameIdentity(info, rootInfo)) return true;
			const parent = dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
	}
	return false;
}

export interface FencePolicy {
	mode: SandboxMode;
	workspaceRoot: string;
}

/**
 * 校验一个写路径。danger-full-access 放行；read-only 全拒；workspace-write
 * 要求 canonicalizeTarget 后落在 writableRoots 内。违规抛 FenceDenialError。
 * 调用方（tools.ts）传入的是已对 cwd 解析的路径；此处 resolvePath 兜底相对路径。
 */
export function assertWriteAllowed(absPath: string, policy: FencePolicy): void {
	if (policy.mode === "danger-full-access") return;
	const roots = writableRoots(policy.mode, policy.workspaceRoot);
	const target = canonicalizeTarget(absPath);
	if (!isWithinRoots(target, roots)) throw new FenceDenialError(resolvePath(absPath), policy.mode);
}
