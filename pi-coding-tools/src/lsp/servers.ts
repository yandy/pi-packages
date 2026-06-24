import { existsSync } from "node:fs";
import { delimiter, extname } from "node:path";
import type { CodingToolsConfig, ServerOverride } from "../config";

export interface ServerDef {
	id: string;
	command: string[];
	extensions: string[];
	languageId: string; // LSP languageId for didOpen
	installHint: string;
	initOptions?: Record<string, unknown>;
}

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

export const BUILTIN_SERVERS: ServerDef[] = [
	{
		id: "typescript-language-server",
		command: ["typescript-language-server", "--stdio"],
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		languageId: "typescript",
		installHint: "npm install -g typescript-language-server typescript",
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
		installHint: "Install Eclipse JDT Language Server (jdtls). Requires JDK 17+.",
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

function applyOverride(server: ServerDef, override: ServerOverride | undefined): ServerDef | null {
	if (!override) return server;
	if (override.disabled) return null;
	return {
		...server,
		...(override.command ? { command: override.command } : {}),
		...(override.priority !== undefined ? {} : {}),
	};
}

export interface ResolvedServer {
	server: ServerDef;
	installed: boolean;
}

export function resolveServerForFile(path: string, config?: Partial<CodingToolsConfig>): ResolvedServer | null {
	if (config?.lsp?.disabled) return null;
	const langId = detectLanguage(path);
	if (!langId) return null;
	const builtin = BUILTIN_SERVERS.find((s) => s.languageId === langId);
	if (!builtin) return null;
	const override = config?.lsp?.servers?.[builtin.id];
	const server = applyOverride(builtin, override);
	if (!server) return null;
	return { server, installed: isCommandOnPath(server.command[0] ?? "") };
}
