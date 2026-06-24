import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";

const MIN_BINARY_SIZE_BYTES = 10_000;

function isValidBinary(filePath: string): boolean {
	try {
		return statSync(filePath).size > MIN_BINARY_SIZE_BYTES;
	} catch {
		return false;
	}
}

const PLATFORM_PACKAGE_MAP: Record<string, string> = {
	"darwin-arm64": "@ast-grep/cli-darwin-arm64",
	"darwin-x64": "@ast-grep/cli-darwin-x64",
	"linux-arm64": "@ast-grep/cli-linux-arm64-gnu",
	"linux-x64": "@ast-grep/cli-linux-x64-gnu",
	"win32-x64": "@ast-grep/cli-win32-x64-msvc",
	"win32-arm64": "@ast-grep/cli-win32-arm64-msvc",
};

function getPlatformPackageName(): string | null {
	return PLATFORM_PACKAGE_MAP[`${process.platform}-${process.arch}`] ?? null;
}

function findOnPath(binaryName: string): string | null {
	const isWindows = process.platform === "win32";
	const pathEnv = process.env.PATH ?? (isWindows ? (process.env.Path ?? "") : "");
	if (!pathEnv) return null;
	const exts = isWindows ? ["", ".exe"] : [""];
	for (const dir of pathEnv.split(delimiter)) {
		for (const suffix of exts) {
			const candidate = join(dir, binaryName + suffix);
			if (existsSync(candidate) && isValidBinary(candidate)) return candidate;
		}
	}
	return null;
}

// ast-grep 二进制名因安装方式而异：cargo/brew/Linux 装的是 `ast-grep`；
// @ast-grep/cli npm 包内部 shim 叫 `sg`。优先找 ast-grep（标准名），再找 sg。
function findBinaryInCliPackage(binaryName: string): string | null {
	try {
		const require = createRequire(import.meta.url);
		const cliPackageJsonPath = require.resolve("@ast-grep/cli/package.json");
		const cliDirectory = dirname(cliPackageJsonPath);
		const p = join(cliDirectory, binaryName);
		if (existsSync(p) && isValidBinary(p)) return p;
	} catch {}
	return null;
}

function findBinaryInPlatformPackage(): string | null {
	const platformPackage = getPlatformPackageName();
	if (!platformPackage) return null;
	try {
		const require = createRequire(import.meta.url);
		const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
		const packageDirectory = dirname(packageJsonPath);
		const binaryName = process.platform === "win32" ? "ast-grep.exe" : "ast-grep";
		const p = join(packageDirectory, binaryName);
		if (existsSync(p) && isValidBinary(p)) return p;
	} catch {}
	return null;
}

export function findAstGrepPathSync(): string | null {
	// 1. PATH: ast-grep 优先（Linux/cargo/brew 标准），再 sg（npm shim）
	const onPath = findOnPath("ast-grep") ?? findOnPath("sg");
	if (onPath) return onPath;
	// 2. @ast-grep/cli 包内 sg shim
	const inCli = findBinaryInCliPackage(process.platform === "win32" ? "sg.exe" : "sg");
	if (inCli) return inCli;
	// 3. 平台 npm 包（二进制名 ast-grep）
	const inPlatform = findBinaryInPlatformPackage();
	if (inPlatform) return inPlatform;
	return null;
}

let resolved: string | null = null;

export async function getAstGrepPath(): Promise<string | null> {
	if (resolved && existsSync(resolved)) return resolved;
	const p = findAstGrepPathSync();
	if (p) resolved = p;
	return p;
}

export function resetResolvedForTests(): void {
	resolved = null;
}
