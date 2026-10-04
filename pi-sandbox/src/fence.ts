import { basename, dirname, join, resolve as resolvePath, sep } from "node:path";
import { lstatSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
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
 * Ruling 7：realpath 失败处先 lstat 区分"悬空 symlink"与"真缺失"——悬空 symlink
 * 必须继续跟随（readlink，相对目标对 dirname 解析），否则停留词法拼写会放行
 * ws/dangling → 围栏外目标，内核写入时跟随 symlink 即逃逸；ELOOP 守卫 40 次后
 * 回退词法拼写（此时内核写入同样 ELOOP，检查与落点无分歧）。
 */
export function canonicalizeTarget(path: string): string {
	let current = resolvePath(path);
	const tail: string[] = [];
	let symlinkGuard = 0;
	for (;;) {
		try {
			const real = realpathSync.native(current);
			return tail.length === 0 ? real : join(real, ...tail.reverse());
		} catch {
			let lst: Stats | undefined;
			try {
				lst = lstatSync(current);
			} catch {
				lst = undefined;
			}
			if (lst?.isSymbolicLink()) {
				if (++symlinkGuard > 40) return resolvePath(path); // symlink 环：保守回词法拼写
				current = resolvePath(dirname(current), readlinkSync(current));
				continue;
			}
			const parent = dirname(current);
			if (parent === current) return resolvePath(path); // 连根都不可解析：保留词法拼写（保守，匹配不到任何授予根以外的东西）
			tail.push(basename(current));
			current = parent;
		}
	}
}

function sameIdentity(a: Stats, b: Stats): boolean {
	// libuv 的 Windows stat 回退（目录句柄被 Defender/索引器瞬时占用时）返回 ino/dev = 0 的
	// “未知身份”；`0 === 0` 会把两个不同的目录判成同一，身份回退 fail-open（2026-10-04 真机
	// CI 捕获）。身份未知 ≠ 身份相同：零身份一律不匹配。POSIX 的 stat 对存在文件不会给 0。
	return a.ino !== 0 && a.dev === b.dev && a.ino === b.ino;
}

/** 大小写归一：平台不敏感时统一小写（win32 的盘符/目录名拼写差异）。 */
function comparablePath(path: string, caseSensitive: boolean): string {
	return caseSensitive ? path : path.toLowerCase();
}

/** win32 上 "/" 与 "\\" 都是分隔符：比较前先统一成 path.sep；POSIX 不动。 */
const normalizeSeparators = (p: string) => (sep === "\\" ? p.replaceAll("/", "\\") : p);

/** 尾部分隔符：win32 两种都去（盘根 "C:\\" → "C:"）；POSIX 只去 "/"——"\\" 在那里是合法文件名字符。 */
const TRAILING_SEPARATORS = sep === "\\" ? /[\\/]+$/ : /\/+$/;

/** 裸盘符（"C:"）：表示"每驱动器当前目录"（drive-relative），不是盘根；子路径必须由分隔符继续。 */
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:$/;

/** 盘符相对路径（"C:" / "C:work"）：语义依赖 per-drive CWD，是歧义路径，不得进入围栏判定。 */
const DRIVE_RELATIVE_PATH = /^[A-Za-z]:(?![\\/])/;

/**
 * 词法包含判定：分隔符用 path.sep（win32 上 \ 与 / 都可能出现，先归一化），
 * 且必须落在分隔符边界上——C:\work\demo2 不是 C:\work\demo 的子路径。
 * 大小写由调用方按平台约定传入；拼写不同（大小写、8.3 短名、junction）时
 * 仍由下面的 dev/ino 身份回退兜底。
 */
function isLexicallyUnder(target: string, root: string, caseSensitive: boolean): boolean {
	const t = comparablePath(normalizeSeparators(target), caseSensitive);
	// 去尾部（重复）分隔符：根前缀不能带分隔符，否则 C:\work\demo2 会被误判为子路径。
	// POSIX "/" 去尾为空，连同空根一起保持根语义。
	const r = comparablePath(normalizeSeparators(root).replace(TRAILING_SEPARATORS, "") || sep, caseSensitive);
	// win32 盘根 "C:\\" 去尾后就是裸盘符 "C:"；裸盘符是"每驱动器当前目录"而非盘根，
	// 因此必须由分隔符继续（C:\…）才可能是它的子路径——裸 "C:" 与 "C:work" 都不算。
	if (DRIVE_LETTER_PREFIX.test(r)) return t.startsWith(`${r}${sep}`);
	if (t === r) return true;
	return t.startsWith(r === sep ? r : `${r}${sep}`);
}

/**
 * containment 判定（deepseek dsh-fs-sandbox 语义）：词法快路径处理常规 canonical
 * 拼写；拼写不一致时沿 target 的存在祖先向上 walk，用文件系统身份（dev+ino）
 * 与授予根比较——容忍 missing 后缀，防祖先 symlink 换绑逃逸。
 * caseSensitive 缺省按平台推导（win32 不敏感）；身份回退本身与大小写无关。
 */
export function isWithinRoots(
	target: string,
	roots: readonly string[],
	caseSensitive: boolean = process.platform !== "win32",
): boolean {
	// win32：裸盘符与盘符相对路径按 per-drive CWD 解析，结果随进程 CWD 漂移；
	// 围栏判定必须确定，故一律视为不在任何授予根内（POSIX 宿主无此语义，不适用）。
	if (sep === "\\" && DRIVE_RELATIVE_PATH.test(normalizeSeparators(target))) return false;
	for (const root of roots) {
		if (isLexicallyUnder(target, root, caseSensitive)) return true;
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
	/** 测试注入（testing.md「参数注入」）：围栏比较是否大小写敏感；生产不传，缺省按 process.platform 推导。 */
	caseSensitive?: boolean;
	/** 测试注入（testing.md「参数注入」）：替换缺省 tmp 根（`defaultTmpRoots()`：win32 仅 `os.tmpdir()`，其余 `"/tmp"` + `os.tmpdir()`）；生产不传。 */
	_tmpRoots?: readonly string[];
}

/**
 * 校验一个写路径。danger-full-access 放行；read-only 全拒；workspace-write
 * 要求 canonicalizeTarget 后落在 writableRoots 内。违规抛 FenceDenialError。
 * 调用方（tools.ts）传入的是已对 cwd 解析的路径；此处 resolvePath 兜底相对路径。
 */
export function assertWriteAllowed(absPath: string, policy: FencePolicy): void {
	if (policy.mode === "danger-full-access") return;
	const roots = writableRoots(policy.mode, policy.workspaceRoot, policy._tmpRoots);
	const target = canonicalizeTarget(absPath);
	const caseSensitive = policy.caseSensitive ?? process.platform !== "win32";
	if (!isWithinRoots(target, roots, caseSensitive)) throw new FenceDenialError(resolvePath(absPath), policy.mode);
}
