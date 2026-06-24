import { spawn } from "node:child_process";
import { getAstGrepPath } from "./binary";
import type { CliLanguage, CliRewriteMatch, RunSgRewriteOptions, SgRewriteResult } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCliRewriteMatch(v: unknown): v is CliRewriteMatch {
	if (!isRecord(v)) return false;
	const range = v.range;
	const charCount = v.charCount;
	const replacementOffsets = v.replacementOffsets;
	if (
		!isRecord(range) ||
		!isRecord(charCount) ||
		!isRecord(replacementOffsets) ||
		!isRecord(range.byteOffset) ||
		!isRecord(range.start) ||
		!isRecord(range.end)
	) {
		return false;
	}
	return (
		typeof v.text === "string" &&
		typeof v.file === "string" &&
		typeof v.lines === "string" &&
		typeof v.language === "string" &&
		typeof v.replacement === "string" &&
		typeof charCount.leading === "number" &&
		typeof charCount.trailing === "number" &&
		typeof range.byteOffset.start === "number" &&
		typeof range.byteOffset.end === "number" &&
		typeof range.start.line === "number" &&
		typeof range.start.column === "number" &&
		typeof range.end.line === "number" &&
		typeof range.end.column === "number" &&
		typeof replacementOffsets.start === "number" &&
		typeof replacementOffsets.end === "number"
	);
}

export function parseRewriteStdout(stdout: string): Pick<SgRewriteResult, "matches" | "totalMatches" | "truncated"> {
	if (!stdout.trim()) return { matches: [], totalMatches: 0, truncated: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { matches: [], totalMatches: 0, truncated: false };
	}
	const matches = Array.isArray(parsed) && parsed.every(isCliRewriteMatch) ? (parsed as CliRewriteMatch[]) : [];
	return { matches, totalMatches: matches.length, truncated: false };
}

const REWRITE_TIMEOUT_MS = 30_000;

const INSTALL_HINT = [
	"ast-grep binary not found.",
	"",
	"Install options:",
	"  npm install -g @ast-grep/cli",
	"  cargo install ast-grep --locked",
	"  brew install ast-grep",
].join("\n");

function buildArgs(options: RunSgRewriteOptions, apply: boolean): string[] {
	const args = ["run", "-p", options.pattern, "-r", options.rewrite, "--lang", options.lang];
	if (apply) {
		args.push("-U"); // apply pass: write files (NO --json, it neutralizes -U)
	} else {
		args.push("--json=compact"); // preview pass: structured JSON, no write
	}
	args.push(...(options.paths.length > 0 ? options.paths : ["."]));
	return args;
}

// Spawn one ast-grep run and resolve its SgRewriteResult. `applyPass` selects
// -U (write, plain stdout) vs --json=compact (preview, structured stdout).
function spawnRun(cliPath: string, options: RunSgRewriteOptions, applyPass: boolean): Promise<SgRewriteResult> {
	return new Promise<SgRewriteResult>((resolve) => {
		const proc = spawn(cliPath, buildArgs(options, applyPass), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			resolve({
				matches: [],
				totalMatches: 0,
				truncated: true,
				truncatedReason: "timeout",
				error: "rewrite timed out",
				applied: options.apply,
			});
		}, REWRITE_TIMEOUT_MS);

		proc.stdout.setEncoding("utf-8");
		proc.stderr.setEncoding("utf-8");
		proc.stdout.on("data", (c: string) => (stdout += c));
		proc.stderr.on("data", (c: string) => (stderr += c));

		proc.once("error", () => {
			clearTimeout(timer);
			resolve({ matches: [], totalMatches: 0, truncated: false, error: INSTALL_HINT, applied: options.apply });
		});
		proc.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 && !stdout.trim()) {
				if (stderr.includes("No files found")) {
					resolve({ matches: [], totalMatches: 0, truncated: false, applied: options.apply });
					return;
				}
				resolve({
					matches: [],
					totalMatches: 0,
					truncated: false,
					error: stderr.trim() || `ast-grep exited with code ${code}`,
					applied: options.apply,
				});
				return;
			}
			const parsed = parseRewriteStdout(stdout);
			resolve({ ...parsed, applied: options.apply });
		});
	});
}

export async function runAstGrepRewrite(options: RunSgRewriteOptions): Promise<SgRewriteResult> {
	const cliPath = await getAstGrepPath();
	if (!cliPath) {
		return { matches: [], totalMatches: 0, truncated: false, error: INSTALL_HINT, applied: options.apply };
	}

	// Preview pass (always): structured JSON with file/replacement/range.
	const preview = await spawnRun(cliPath, options, false);
	if (preview.error || preview.matches.length === 0) return preview;

	// Apply pass (only when requested): -U writes files, plain stdout.
	// Reuses the preview's structured matches so callers still get per-file
	// detail; only `applied` flips to true.
	if (!options.apply) return preview;
	const applyResult = await spawnRun(cliPath, options, true);
	if (applyResult.error) return applyResult; // write failed — surface it
	return { ...preview, applied: true };
}
