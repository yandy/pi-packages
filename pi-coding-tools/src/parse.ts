export type ParsedPatch =
	| { type: "add"; filePath: string; content: string }
	| { type: "delete"; filePath: string }
	| { type: "update"; filePath: string; movePath?: string; chunks: PatchChunk[] };

export type PatchChunk = {
	changeContexts: string[];
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
};

export class PatchParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchParseError";
	}
}

export const APPLY_PATCH_FREEFORM_DESCRIPTION =
	"Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export function normalizePatchText(patchText: string): string {
	return patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function stripHeredoc(input: string): string {
	const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	if (heredocMatch) {
		return heredocMatch[2] ?? input;
	}
	return input;
}

export function normalizeSeekLine(line: string): string {
	return line
		.trim()
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
): { index: number; fuzz: 0 | 1 | 100 | 10000 } | undefined {
	if (pattern.length === 0) {
		return { index: start, fuzz: 0 };
	}
	if (pattern.length > lines.length) {
		return undefined;
	}

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const lastStart = lines.length - pattern.length;
	const matches = (index: number, compare: (left: string, right: string) => boolean): boolean => {
		for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
			const line = lines[index + patternIndex];
			const expected = pattern[patternIndex];
			if (line === undefined || expected === undefined || !compare(line, expected)) {
				return false;
			}
		}
		return true;
	};
	const matchesPrepared = (index: number, preparedLines: string[], preparedPattern: string[]): boolean => {
		for (let patternIndex = 0; patternIndex < preparedPattern.length; patternIndex++) {
			const line = preparedLines[index + patternIndex];
			const expected = preparedPattern[patternIndex];
			if (line === undefined || expected === undefined || line !== expected) {
				return false;
			}
		}
		return true;
	};

	for (let index = searchStart; index <= lastStart; index++) {
		if (matches(index, (line, expected) => line === expected)) {
			return { index, fuzz: 0 };
		}
	}
	const linesTrimEnd = lines.map((line) => line.trimEnd());
	const patternTrimEnd = pattern.map((line) => line.trimEnd());
	for (let index = searchStart; index <= lastStart; index++) {
		if (matchesPrepared(index, linesTrimEnd, patternTrimEnd)) {
			return { index, fuzz: 1 };
		}
	}
	const linesTrim = lines.map((line) => line.trim());
	const patternTrim = pattern.map((line) => line.trim());
	for (let index = searchStart; index <= lastStart; index++) {
		if (matchesPrepared(index, linesTrim, patternTrim)) {
			return { index, fuzz: 100 };
		}
	}
	const linesNormalized = lines.map(normalizeSeekLine);
	const patternNormalized = pattern.map(normalizeSeekLine);
	for (let index = searchStart; index <= lastStart; index++) {
		if (matchesPrepared(index, linesNormalized, patternNormalized)) {
			return { index, fuzz: 10000 };
		}
	}

	return undefined;
}

export function extractPatchedPaths(patchText: string): string[] {
	const normalized = stripHeredoc(normalizePatchText(patchText));
	const matches = normalized.matchAll(/^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$/gm);
	return Array.from(matches, (match) => match[1] ?? "");
}

export function parsePatch(patchText: string): ParsedPatch[] {
	const normalized = stripHeredoc(normalizePatchText(patchText).trim()).trim();
	const lines = normalized.split("\n");
	const beginIndex = lines[0]?.trim() === "*** Begin Patch" ? 0 : -1;
	const lastLine = lines[lines.length - 1];
	const endIndex = lastLine?.trim() === "*** End Patch" ? lines.length - 1 : -1;

	if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
		throw new PatchParseError("Invalid patch format: expected *** Begin Patch ... *** End Patch envelope");
	}

	const hunks: ParsedPatch[] = [];
	let index = beginIndex + 1;
	while (index < endIndex) {
		const line = lines[index] ?? "";
		if (!line.startsWith("*** ")) {
			index++;
			continue;
		}

		if (line.startsWith("*** Add File: ")) {
			const filePath = line.slice("*** Add File: ".length);
			index++;
			const contentLines: string[] = [];
			while (index < endIndex) {
				const nextLine = lines[index] ?? "";
				if (nextLine.startsWith("*** ")) {
					break;
				}
				if (!nextLine.startsWith("+")) {
					throw new PatchParseError("Invalid patch format: Add File lines must start with '+'");
				}
				contentLines.push(nextLine.slice(1));
				index++;
			}
			hunks.push({
				type: "add",
				filePath,
				content: contentLines.length === 0 ? "" : `${contentLines.join("\n")}\n`,
			});
			continue;
		}

		if (line.startsWith("*** Delete File: ")) {
			hunks.push({ type: "delete", filePath: line.slice("*** Delete File: ".length) });
			index++;
			continue;
		}

		if (line.startsWith("*** Update File: ")) {
			const filePath = line.slice("*** Update File: ".length);
			index++;
			let movePath: string | undefined;
			if ((lines[index] ?? "").startsWith("*** Move to: ")) {
				movePath = (lines[index] ?? "").slice("*** Move to: ".length);
				index++;
			}

			const chunks: PatchChunk[] = [];
			while (index < endIndex) {
				const nextLine = lines[index] ?? "";
				if (nextLine.trim() === "") {
					index++;
					continue;
				}
				if (nextLine.startsWith("*** ")) {
					break;
				}

				const allowMissingContext = chunks.length === 0;
				const changeContexts: string[] = [];
				if (nextLine.startsWith("@@")) {
					while (index < endIndex) {
						const contextLine = lines[index] ?? "";
						if (contextLine === "@@") {
							index++;
							continue;
						}
						if (contextLine.startsWith("@@ ")) {
							changeContexts.push(contextLine.slice("@@ ".length));
							index++;
							continue;
						}
						break;
					}
				} else if (!allowMissingContext) {
					throw new PatchParseError(`Expected update hunk to start with a @@ context marker, got: '${nextLine}'`);
				}

				const oldLines: string[] = [];
				const newLines: string[] = [];
				let isEndOfFile = false;
				let parsedLines = 0;
				while (index < endIndex) {
					const hunkLine = lines[index] ?? "";
					if (hunkLine === "*** End of File") {
						if (parsedLines === 0) {
							throw new PatchParseError("Update hunk does not contain any lines");
						}
						isEndOfFile = true;
						index++;
						break;
					}
					if (hunkLine.startsWith("@@") || hunkLine.startsWith("*** ")) {
						break;
					}
					const prefix = hunkLine[0];
					const value = hunkLine.slice(1);
					if (prefix === undefined) {
						oldLines.push("");
						newLines.push("");
					} else if (prefix === " ") {
						oldLines.push(value);
						newLines.push(value);
					} else if (prefix === "-") {
						oldLines.push(value);
					} else if (prefix === "+") {
						newLines.push(value);
					} else if (parsedLines > 0) {
						break;
					} else {
						throw new PatchParseError(
							`Unexpected line found in update hunk: '${hunkLine}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
						);
					}
					parsedLines++;
					index++;
				}

				if (parsedLines === 0) {
					throw new PatchParseError("Update hunk does not contain any lines");
				}
				chunks.push({ changeContexts, oldLines, newLines, isEndOfFile });
			}
			if (chunks.length === 0 && !movePath) {
				throw new PatchParseError(`Update file hunk for path '${filePath}' is empty`);
			}

			hunks.push(
				movePath !== undefined ? { type: "update", filePath, movePath, chunks } : { type: "update", filePath, chunks },
			);
			continue;
		}

		throw new PatchParseError(
			`'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
		);
	}

	return hunks;
}

export function parseNonEmptyPatch(patchText: string): ParsedPatch[] {
	const hunks = parsePatch(patchText);
	if (hunks.length > 0) {
		return hunks;
	}

	const normalized = normalizePatchText(patchText).trim();
	if (normalized === "*** Begin Patch\n*** End Patch") {
		throw new PatchParseError("patch rejected: empty patch");
	}
	throw new PatchParseError("apply_patch verification failed: no hunks found");
}

export function splitFileLines(content: string): string[] {
	const lines = normalizePatchText(content).split("\n");
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}
