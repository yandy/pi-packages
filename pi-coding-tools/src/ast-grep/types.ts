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

export interface SgResult {
	matches: CliMatch[];
	totalMatches: number;
	truncated: boolean;
	truncatedReason?: string;
	error?: string;
}

export interface RunSgOptions {
	pattern: string;
	lang: CliLanguage;
	paths: string[];
}

export interface CliRewriteMatch extends CliMatch {
	replacement: string;
	replacementOffsets: { start: number; end: number };
}

export interface SgRewriteResult {
	matches: CliRewriteMatch[];
	totalMatches: number;
	truncated: boolean;
	truncatedReason?: string;
	error?: string;
	applied: boolean;
}

export interface RunSgRewriteOptions extends RunSgOptions {
	rewrite: string;
	apply: boolean;
}
