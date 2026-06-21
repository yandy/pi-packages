import { mkdir, realpath, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./write-file-atomic";
import type { ParsedPatch, PatchChunk } from "./parse";
import { parseNonEmptyPatch, seekSequence, splitFileLines } from "./parse";

export type ApplyPatchFailure = {
	filePath: string;
	operation: "add" | "delete" | "update";
	message: string;
};

export type ApplyPatchRecoveryInstructions = {
	mustReadFiles: string[];
	mustNotReadFiles: string[];
};

export type ApplyPatchProgress = {
	applied: number;
	failed: number;
	total: number;
};

export type ApplyPatchProgressCallback = (progress: ApplyPatchProgress) => Promise<void> | void;

export type ApplyPatchResult = {
	summaries: string[];
	appliedFiles: string[];
	failures: ApplyPatchFailure[];
	hasPartialSuccess: boolean;
	recoveryInstructions: ApplyPatchRecoveryInstructions;
	details: {
		fuzz: number;
	};
};

export class PatchApplicationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchApplicationError";
	}
}

export class ApplyPatchError extends Error {
	public readonly failures: ApplyPatchFailure[];
	public readonly result: ApplyPatchResult;

	constructor(message: string, result: ApplyPatchResult) {
		super(message);
		this.name = "ApplyPatchError";
		this.failures = result.failures;
		this.result = result;
	}

	hasPartialSuccess(): boolean {
		return this.result.hasPartialSuccess;
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function isPathWithinWorkspace(workspacePath: string, candidatePath: string): boolean {
	const relativePath = path.relative(workspacePath, candidatePath);
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
	);
}

async function findExistingAncestor(directoryPath: string, workspacePath: string): Promise<string> {
	let currentPath = directoryPath;
	while (isPathWithinWorkspace(workspacePath, currentPath)) {
		try {
			await stat(currentPath);
			return currentPath;
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw error;
			}
		}

		const parentPath = path.dirname(currentPath);
		if (parentPath === currentPath) {
			break;
		}
		currentPath = parentPath;
	}

	throw new PatchApplicationError(`Patch path escapes workspace: ${directoryPath}`);
}

async function resolvePatchPath(cwd: string, filePath: string): Promise<string> {
	const workspacePath = await realpath(cwd);
	const absolutePath = path.resolve(workspacePath, filePath);
	if (!isPathWithinWorkspace(workspacePath, absolutePath)) {
		throw new PatchApplicationError(`Patch path escapes workspace: ${filePath}`);
	}

	const existingAncestor = await findExistingAncestor(path.dirname(absolutePath), workspacePath);
	const realAncestor = await realpath(existingAncestor);
	if (!isPathWithinWorkspace(workspacePath, realAncestor)) {
		throw new PatchApplicationError(`Patch path escapes workspace: ${filePath}`);
	}

	return absolutePath;
}

function replaceChunks(content: string, filePath: string, chunks: PatchChunk[]): { content: string; fuzz: number } {
	const originalLines = splitFileLines(content);
	const replacements: { start: number; oldLength: number; newLines: string[] }[] = [];
	let lineIndex = 0;
	let fuzz = 0;

	for (const chunk of chunks) {
		for (const changeContext of chunk.changeContexts) {
			if (!changeContext) {
				continue;
			}
			const contextMatch = seekSequence(originalLines, [changeContext], lineIndex, false);
			if (contextMatch === undefined) {
				throw new PatchApplicationError(`Failed to find context '${changeContext}' in ${filePath}`);
			}
			fuzz += contextMatch.fuzz;
			lineIndex = contextMatch.index + 1;
		}

		if (chunk.oldLines.length === 0) {
			const insertionIndex =
				originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
			replacements.push({ start: insertionIndex, oldLength: 0, newLines: chunk.newLines });
			continue;
		}

		let pattern = chunk.oldLines;
		let newLines = chunk.newLines;
		let foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		if (foundAt === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newLines[newLines.length - 1] === "") {
				newLines = newLines.slice(0, -1);
			}
			foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}

		if (foundAt === undefined) {
			throw new PatchApplicationError(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		}

		fuzz += foundAt.fuzz;
		replacements.push({ start: foundAt.index, oldLength: pattern.length, newLines });
		lineIndex = foundAt.index + pattern.length;
	}

	const nextLines = [...originalLines];
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
		nextLines.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
	}
	nextLines.push("");
	return { content: nextLines.join("\n"), fuzz };
}

async function applySingleHunk(
	cwd: string,
	hunk: ParsedPatch,
): Promise<{ summary: string; appliedFile: string; fuzz: number }> {
	const absolutePath = await resolvePatchPath(cwd, hunk.filePath);
	if (hunk.type === "add") {
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFileAtomic(absolutePath, hunk.content);
		return { summary: `add: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0 };
	}

	if (hunk.type === "delete") {
		await stat(absolutePath);
		await rm(absolutePath);
		return { summary: `delete: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0 };
	}

	const currentContent = await readFile(absolutePath, "utf-8");
	const chunkResult =
		hunk.chunks.length === 0
			? { content: currentContent, fuzz: 0 }
			: replaceChunks(currentContent, hunk.filePath, hunk.chunks);
	const nextContent = chunkResult.content;

	if (hunk.movePath) {
		const absoluteMovePath = await resolvePatchPath(cwd, hunk.movePath);
		await mkdir(path.dirname(absoluteMovePath), { recursive: true });
		await writeFileAtomic(absoluteMovePath, nextContent);
		if (absoluteMovePath !== absolutePath) {
			await rm(absolutePath);
		}
		return {
			summary: `move: ${hunk.filePath} -> ${hunk.movePath}`,
			appliedFile: hunk.movePath,
			fuzz: chunkResult.fuzz,
		};
	}

	await writeFileAtomic(absolutePath, nextContent);
	return { summary: `update: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: chunkResult.fuzz };
}

async function notifyApplyPatchProgress(
	onProgress: ApplyPatchProgressCallback | undefined,
	progress: ApplyPatchProgress,
): Promise<void> {
	try {
		await onProgress?.(progress);
	} catch {
		// Rendering progress must not affect patch application or recovery details.
	}
}

function createRecoveryInstructions(
	result: Pick<ApplyPatchResult, "appliedFiles" | "failures">,
): ApplyPatchRecoveryInstructions {
	const mustReadFiles = [...new Set(result.failures.map((failure) => failure.filePath))];
	const mustReadFileSet = new Set(mustReadFiles);
	const mustNotReadFiles = [...new Set(result.appliedFiles.filter((filePath) => !mustReadFileSet.has(filePath)))];
	return { mustReadFiles, mustNotReadFiles };
}

export async function applyPatch(cwd: string, patchText: string): Promise<string[]> {
	const hunks = parseNonEmptyPatch(patchText);

	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	for (const hunk of hunks) {
		try {
			const { summary, appliedFile } = await applySingleHunk(cwd, hunk);
			summaries.push(summary);
			appliedFiles.push(appliedFile);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const failure = { filePath: hunk.filePath, operation: hunk.type, message } satisfies ApplyPatchFailure;
			const result: ApplyPatchResult = {
				summaries,
				appliedFiles,
				failures: [failure],
				hasPartialSuccess: appliedFiles.length > 0,
				recoveryInstructions: createRecoveryInstructions({
					appliedFiles,
					failures: [failure],
				}),
				details: { fuzz: 0 },
			};
			throw new ApplyPatchError(message, result);
		}
	}

	return summaries;
}

export async function applyParsedPatchDetailed(
	cwd: string,
	hunks: ParsedPatch[],
	onProgress?: ApplyPatchProgressCallback,
): Promise<ApplyPatchResult> {
	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	const failures: ApplyPatchFailure[] = [];
	let fuzz = 0;

	for (const hunk of hunks) {
		try {
			const { summary, appliedFile, fuzz: hunkFuzz } = await applySingleHunk(cwd, hunk);
			summaries.push(summary);
			appliedFiles.push(appliedFile);
			fuzz += hunkFuzz;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push({ filePath: hunk.filePath, operation: hunk.type, message });
		}
		await notifyApplyPatchProgress(onProgress, {
			applied: appliedFiles.length,
			failed: failures.length,
			total: hunks.length,
		});
	}

	const result: ApplyPatchResult = {
		summaries,
		appliedFiles,
		failures,
		hasPartialSuccess: appliedFiles.length > 0 && failures.length > 0,
		recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [] },
		details: { fuzz },
	};
	result.recoveryInstructions = createRecoveryInstructions(result);
	return result;
}

export async function applyPatchDetailed(
	cwd: string,
	patchText: string,
	onProgress?: ApplyPatchProgressCallback,
): Promise<ApplyPatchResult> {
	return applyParsedPatchDetailed(cwd, parseNonEmptyPatch(patchText), onProgress);
}
