import { spawn } from "node:child_process";
import { extname } from "node:path";
import { getAstGrepPath, INSTALL_HINT } from "./binary";
import type { CliLanguage, CliMatch, RunSgOptions, SgResult } from "./types";

const SEARCH_TIMEOUT_MS = 30_000;

const EXT_TO_LANG: Record<string, CliLanguage> = {
	".ts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".java": "java",
	".kt": "kotlin",
	".kts": "kotlin",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
};

export function inferLangFromPath(path: string): CliLanguage | undefined {
	return EXT_TO_LANG[extname(path).toLowerCase()];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCliMatch(v: unknown): v is CliMatch {
	if (!isRecord(v)) return false;
	const range = v.range;
	const charCount = v.charCount;
	if (!isRecord(range) || !isRecord(charCount)) return false;
	const byteOffset = range.byteOffset;
	return (
		typeof v.text === "string" &&
		typeof v.file === "string" &&
		typeof v.lines === "string" &&
		typeof v.language === "string" &&
		typeof charCount.leading === "number" &&
		typeof charCount.trailing === "number" &&
		isRecord(byteOffset) &&
		typeof byteOffset.start === "number" &&
		typeof byteOffset.end === "number" &&
		isRecord(range.start) &&
		typeof range.start.line === "number" &&
		typeof range.start.column === "number" &&
		isRecord(range.end) &&
		typeof range.end.line === "number" &&
		typeof range.end.column === "number"
	);
}

export function parseSgStdout(stdout: string): SgResult {
	if (!stdout.trim()) return { matches: [], totalMatches: 0, truncated: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { matches: [], totalMatches: 0, truncated: false };
	}
	const matches = Array.isArray(parsed) && parsed.every(isCliMatch) ? (parsed as CliMatch[]) : [];
	return { matches, totalMatches: matches.length, truncated: false };
}

function buildArgs(options: RunSgOptions): string[] {
	const args = ["run", "-p", options.pattern, "--lang", options.lang, "--json=compact"];
	args.push(...(options.paths.length > 0 ? options.paths : ["."]));
	return args;
}

export async function runAstGrep(options: RunSgOptions): Promise<SgResult> {
	const cliPath = await getAstGrepPath();
	if (!cliPath) return { matches: [], totalMatches: 0, truncated: false, error: INSTALL_HINT };

	return new Promise<SgResult>((resolve) => {
		const proc = spawn(cliPath, buildArgs(options), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			resolve({
				matches: [],
				totalMatches: 0,
				truncated: true,
				truncatedReason: "timeout",
				error: "search timed out",
			});
		}, SEARCH_TIMEOUT_MS);

		proc.stdout.setEncoding("utf-8");
		proc.stderr.setEncoding("utf-8");
		proc.stdout.on("data", (c: string) => (stdout += c));
		proc.stderr.on("data", (c: string) => (stderr += c));

		proc.once("error", () => {
			clearTimeout(timer);
			resolve({ matches: [], totalMatches: 0, truncated: false, error: INSTALL_HINT });
		});
		proc.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 && !stdout.trim()) {
				if (stderr.includes("No files found")) {
					resolve({ matches: [], totalMatches: 0, truncated: false });
					return;
				}
				resolve({
					matches: [],
					totalMatches: 0,
					truncated: false,
					error: stderr.trim() || `ast-grep exited with code ${code}`,
				});
				return;
			}
			resolve(parseSgStdout(stdout));
		});
	});
}
