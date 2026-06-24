import type { CliRewriteMatch, SgRewriteResult } from "./types";

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
