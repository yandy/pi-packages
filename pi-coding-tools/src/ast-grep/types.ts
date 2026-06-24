export type CliLanguage = "typescript" | "tsx" | "javascript" | "python" | "java" | "kotlin" | "c" | "cpp";

export interface Position {
	line: number; // 0-based
	column: number; // 0-based
}

export interface Range {
	start: Position;
	end: Position;
	byteOffset: { start: number; end: number };
}

export interface CliMatch {
	text: string;
	range: Range;
	file: string;
	lines: string;
	charCount: { leading: number; trailing: number };
	language: string;
}

export type SgTruncationReason = "max_matches" | "max_output_bytes" | "timeout";

export interface SgResult {
	matches: CliMatch[];
	totalMatches: number;
	truncated: boolean;
	truncatedReason?: SgTruncationReason;
	error?: string;
}

export interface RunSgOptions {
	pattern: string;
	lang: CliLanguage;
	paths: string[];
}
