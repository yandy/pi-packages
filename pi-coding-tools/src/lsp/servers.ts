import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import type { CodingToolsConfig, ServerOverride } from "../config";

/** LSP 服务器定义；`command` 与 `resolve` 至少提供一个 */
export interface ServerSpec {
	id: string;
	/** 静态命令；有 `resolve` 时由它决定 */
	command?: string[];
	/** 按会话工作目录解析命令；返回 null 表示该候选在当前项目不可用 */
	resolve?: (root: string) => string[] | null;
	extensions: string[];
	languageId: string; // LSP languageId for didOpen
	installHint: string;
	initOptions?: Record<string, unknown>;
}

/** 已解析的服务器（`command` 一定存在），供 client 使用 */
export type ServerDef = ServerSpec & { command: string[] };

function isCommandOnPath(cmd: string): boolean {
	// 简化：用 existsSync 扫 PATH（与 binary.ts 一致风格）
	const pathEnv = process.env.PATH ?? "";
	const isWin = process.platform === "win32";
	const exts = isWin ? (process.env.PATHEXT ?? ".exe").split(";") : [""];
	for (const dir of pathEnv.split(delimiter)) {
		for (const ext of exts) {
			if (existsSync(`${dir}/${cmd}${ext}`)) return true;
		}
	}
	return false;
}

const TS_NATIVE_MIN_MAJOR = 7;
const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function readPackageMajor(pkgJson: string): number | undefined {
	try {
		const pkg = JSON.parse(readFileSync(pkgJson, "utf-8")) as { version?: unknown };
		if (typeof pkg.version !== "string") return undefined;
		const major = Number.parseInt(pkg.version, 10);
		return Number.isNaN(major) ? undefined : major;
	} catch {
		return undefined;
	}
}

/**
 * TypeScript 7+ 内置 native LSP（`tsc --lsp --stdio`，无需 tsserver / typescript-language-server）。
 * 只认从会话工作目录逐级向上的**最近**一个 typescript：最近的版本 < 7 时返回 null，不回退到祖先目录，
 * 以免用错项目版本（与 typescript-language-server 的就近语义一致）。
 */
export function resolveTypescriptNativeCommand(root: string): string[] | null {
	let dir = resolve(root);
	for (;;) {
		const pkgDir = join(dir, "node_modules", "typescript");
		const pkgJson = join(pkgDir, "package.json");
		if (existsSync(pkgJson)) {
			const major = readPackageMajor(pkgJson);
			if (major === undefined || major < TS_NATIVE_MIN_MAJOR) return null;
			const entry = join(pkgDir, "lib", "tsc.js");
			// 用 node 启动：bin/tsc 的 shebang 在 Windows 上不能直接 spawn；该入口会转发到本平台的 native 二进制
			return existsSync(entry) ? ["node", entry, "--lsp", "--stdio"] : null;
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export const BUILTIN_SERVERS: ServerSpec[] = [
	{
		id: "tsc",
		resolve: resolveTypescriptNativeCommand,
		extensions: TS_EXTENSIONS,
		languageId: "typescript",
		installHint:
			"TypeScript 7+ in the project provides it (npm i -D typescript); the native LSP needs 'node' on PATH",
	},
	{
		id: "typescript-language-server",
		command: ["typescript-language-server", "--stdio"],
		extensions: TS_EXTENSIONS,
		languageId: "typescript",
		installHint: "npm install -g typescript-language-server typescript@6",
	},
	{
		id: "pyright",
		command: ["pyright-langserver", "--stdio"],
		extensions: [".py"],
		languageId: "python",
		installHint: "npm install -g pyright  (or: pip install basedpyright && use basedpyright-langserver)",
	},
	{
		id: "jdtls",
		command: ["jdtls"],
		extensions: [".java"],
		languageId: "java",
		installHint: "Install Eclipse JDT Language Server (jdtls). Requires Java 21+.",
	},
	{
		id: "kotlin-language-server",
		command: ["kotlin-language-server"],
		extensions: [".kt", ".kts"],
		languageId: "kotlin",
		installHint: "Install kotlin-language-server (https://github.com/fwcd/kotlin-language-server). Requires JDK.",
	},
	{
		id: "clangd",
		command: ["clangd"],
		extensions: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hxx"],
		languageId: "cpp",
		installHint:
			"Install clangd (apt install clangd / brew install llvm). Needs compile_commands.json for best hover/goto.",
	},
];

const EXT_TO_LANG_ID: Record<string, string> = {};
for (const s of BUILTIN_SERVERS) {
	for (const ext of s.extensions) EXT_TO_LANG_ID[ext.toLowerCase()] = s.languageId;
}

export function detectLanguage(path: string): string | undefined {
	return EXT_TO_LANG_ID[extname(path).toLowerCase()];
}

export interface ResolvedServer {
	server: ServerDef;
	installed: boolean;
}

function resolveCommand(spec: ServerSpec, override: ServerOverride | undefined, root: string): string[] | null {
	if (override?.command) return override.command;
	if (spec.resolve) return spec.resolve(root);
	return spec.command ?? null;
}

/**
 * 按候选顺序（数组顺序即优先级）挑服务器：第一个"命令能解析出来且在 PATH 上"的胜出；
 * 都不可用但有的只是缺二进制时，返回第一个缺二进制的（让调用方报出对应 installHint）。
 */
export function resolveServerForFile(
	path: string,
	root: string,
	config?: Partial<CodingToolsConfig>,
): ResolvedServer | null {
	if (config?.lsp?.disabled) return null;
	const langId = detectLanguage(path);
	if (!langId) return null;

	let firstMissing: ResolvedServer | null = null;
	for (const spec of BUILTIN_SERVERS) {
		if (spec.languageId !== langId) continue;
		const override = config?.lsp?.servers?.[spec.id];
		if (override?.disabled) continue;
		const command = resolveCommand(spec, override, root);
		// 解析不出命令 = 该候选在当前项目不存在（例如项目 TypeScript < 7），继续看下一个候选
		if (!command || command.length === 0) continue;
		const server: ServerDef = { ...spec, command };
		if (isCommandOnPath(command[0] ?? "")) return { server, installed: true };
		firstMissing ??= { server, installed: false };
	}
	return firstMissing;
}
