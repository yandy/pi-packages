import * as Diff from "diff";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { defineTool, getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";

type ThemeBg = "selectedBg" | "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
import { Box } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";
import { Spacer } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	APPLY_PATCH_FREEFORM_DESCRIPTION,
	APPLY_PATCH_LARK_GRAMMAR,
	extractPatchedPaths,
	parseNonEmptyPatch,
	parsePatch,
} from "./parse";
import type { ParsedPatch } from "./parse";
import { applyParsedPatchDetailed } from "./apply";
import type { ApplyPatchProgress, ApplyPatchResult } from "./apply";
import { replaceChunks } from "./apply";
import {
	createPatchDiff,
	formatInFlightCallText,
	formatLineCountSummary,
	formatPatchFileHeader,
	formatPatchFileSummary,
	formatPatchOperation,
	formatPatchPreview,
	readExistingFileForPreview,
	truncatePreview,
} from "./render";
import type { ApplyPatchPreview, ApplyPatchPreviewFile } from "./render";

const APPLY_PATCH_PARAMS = Type.Object({
	input: Type.String({
		description: "The entire contents of the apply_patch command",
	}),
});

type FreeformToolFormat = {
	type: "grammar";
	syntax: "lark";
	definition: string;
};

type ApplyPatchParams = {
	input: string;
};

type ApplyPatchToolDetails = {
	preview?: ApplyPatchPreview;
	progress?: ApplyPatchProgress;
	result?: ApplyPatchResult;
};

type ApplyPatchRenderState = {
	cwd: string;
	patchText: string;
	callText: string;
	collapsed: string;
	expanded: string;
};

const applyPatchRenderStates = new Map<string, ApplyPatchRenderState>();

function applyLayeredBackground(theme: Theme, bgName: ThemeBg, text: string): string {
	const marker = "\x1fpi-bg-marker\x1f";
	const wrappedMarker = theme.bg(bgName, marker);
	const markerIndex = wrappedMarker.indexOf(marker);
	if (markerIndex === -1) {
		return theme.bg(bgName, text);
	}

	const bgStart = wrappedMarker.slice(0, markerIndex);
	const bgEnd = wrappedMarker.slice(markerIndex + marker.length);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes for terminal colors
	const restored = text.replace(/\x1b\[([0-9;]*)m/g, (sequence: string, params: string) => {
		if (params === "" || params.split(";").some((param) => param === "0" || param === "49")) {
			return `${sequence}${bgStart}`;
		}
		return sequence;
	});
	return `${bgStart}${restored}${bgEnd}`;
}

type RenderableAddedDiffLine = { content: string; kind: "added"; lineNumber: string; sign: "+" };
type RenderableRemovedDiffLine = { content: string; kind: "removed"; lineNumber: string; sign: "-" };
type RenderableContextDiffLine = { content: string; kind: "context"; lineNumber: string; sign: " " };
type RenderableContentDiffLine = RenderableAddedDiffLine | RenderableContextDiffLine | RenderableRemovedDiffLine;
type RenderableDiffLine = RenderableContentDiffLine | { kind: "meta"; text: string };

function parseRenderableDiffLine(line: string): RenderableDiffLine {
	const match = line.match(/^([+\- ])(\s*\d+)\s(.*)$/);
	if (!match) {
		return { kind: "meta", text: line };
	}

	const sign = match[1];
	const lineNumber = match[2];
	if ((sign !== "+" && sign !== "-" && sign !== " ") || lineNumber === undefined) {
		return { kind: "meta", text: line };
	}

	const content = match[3] ?? "";
	if (sign === "+") {
		return { content, kind: "added", lineNumber, sign };
	}
	if (sign === "-") {
		return { content, kind: "removed", lineNumber, sign };
	}
	return { content, kind: "context", lineNumber, sign };
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function highlightDiffContent(content: string, filePath: string): string {
	const plainContent = replaceTabs(content);
	const language = getLanguageFromPath(filePath);
	try {
		return highlightCode(plainContent, language)[0] ?? plainContent;
	} catch {
		return plainContent;
	}
}

function renderInlineDiff(
	oldContent: string,
	newContent: string,
	theme: Theme,
): { added: string; removed: string } {
	const parts = Diff.diffWords(replaceTabs(oldContent), replaceTabs(newContent));
	let added = "";
	let removed = "";
	let firstAdded = true;
	let firstRemoved = true;

	for (const part of parts) {
		if (part.added) {
			let value = part.value;
			if (firstAdded) {
				const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
				added += leadingWhitespace;
				value = value.slice(leadingWhitespace.length);
				firstAdded = false;
			}
			if (value) {
				added += theme.inverse(value);
			}
			continue;
		}

		if (part.removed) {
			let value = part.value;
			if (firstRemoved) {
				const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
				removed += leadingWhitespace;
				value = value.slice(leadingWhitespace.length);
				firstRemoved = false;
			}
			if (value) {
				removed += theme.inverse(value);
			}
			continue;
		}

		added += part.value;
		removed += part.value;
	}

	return { added, removed };
}

function renderOpenCodeLikeDiffLine(
	line: RenderableContentDiffLine,
	filePath: string,
	theme: Theme,
	contentOverride?: string,
): string {
	const lineNumber = theme.fg("muted", line.lineNumber);
	if (line.kind === "context") {
		return `${theme.fg("toolDiffContext", line.sign)}${lineNumber} ${highlightDiffContent(line.content, filePath)}`;
	}

	const diffColor = line.kind === "added" ? "toolDiffAdded" : "toolDiffRemoved";
	const background = line.kind === "added" ? "toolSuccessBg" : "toolErrorBg";
	const content =
		contentOverride === undefined
			? highlightDiffContent(line.content, filePath)
			: theme.fg(diffColor, replaceTabs(contentOverride));
	const rendered = `${theme.fg(diffColor, line.sign)}${lineNumber} ${content}`;
	return theme.bg(background, rendered);
}

function renderOpenCodeLikeDiff(diffText: string, filePath: string, theme: Theme): string {
	const parsedLines = diffText.split("\n").map(parseRenderableDiffLine);
	const rendered: string[] = [];
	let index = 0;

	while (index < parsedLines.length) {
		const line = parsedLines[index];
		if (!line) {
			index++;
			continue;
		}

		if (line.kind !== "removed") {
			rendered.push(
				line.kind === "meta"
					? theme.fg("toolDiffContext", line.text)
					: renderOpenCodeLikeDiffLine(line, filePath, theme),
			);
			index++;
			continue;
		}

		const removedLines: RenderableRemovedDiffLine[] = [];
		while (parsedLines[index]?.kind === "removed") {
			const removedLine = parsedLines[index];
			if (removedLine?.kind === "removed") {
				removedLines.push(removedLine);
			}
			index++;
		}

		const addedLines: RenderableAddedDiffLine[] = [];
		while (parsedLines[index]?.kind === "added") {
			const addedLine = parsedLines[index];
			if (addedLine?.kind === "added") {
				addedLines.push(addedLine);
			}
			index++;
		}

		const pairedCount = Math.min(removedLines.length, addedLines.length);
		for (let pairIndex = 0; pairIndex < pairedCount; pairIndex++) {
			const removedLine = removedLines[pairIndex];
			const addedLine = addedLines[pairIndex];
			if (!removedLine || !addedLine) {
				continue;
			}

			const inline = renderInlineDiff(removedLine.content, addedLine.content, theme);
			rendered.push(renderOpenCodeLikeDiffLine(removedLine, filePath, theme, inline.removed));
			rendered.push(renderOpenCodeLikeDiffLine(addedLine, filePath, theme, inline.added));
		}

		for (const removedLine of removedLines.slice(pairedCount)) {
			rendered.push(renderOpenCodeLikeDiffLine(removedLine, filePath, theme));
		}
		for (const addedLine of addedLines.slice(pairedCount)) {
			rendered.push(renderOpenCodeLikeDiffLine(addedLine, filePath, theme));
		}
	}

	return rendered.join("\n");
}

function renderPatchPreview(
	preview: ApplyPatchPreview,
	cwd: string,
	theme: Theme,
	expanded: boolean,
): string {
	if (expanded) {
		try {
			const renderFile = (file: ApplyPatchPreviewFile, headerPrefix: string): string => {
				const header = formatPatchFileHeader(file, cwd);
				if (!file.diff) {
					return headerPrefix.length > 0 ? `${headerPrefix}${formatPatchFileSummary(file, cwd)}` : header;
				}
				const previewDiff = truncatePreview(file.diff);
				const renderedDiff = renderOpenCodeLikeDiff(previewDiff, file.movePath ?? file.filePath, theme);
				if (headerPrefix.length > 0) {
					const nestedHeader = `${headerPrefix}${formatPatchFileSummary(file, cwd)}`;
					return `${nestedHeader}\n${renderedDiff
						.split("\n")
						.map((line) => `    ${line}`)
						.join("\n")}`;
				}
				return `${header}\n${renderedDiff}`;
			};

			if (preview.files.length === 1) {
				const file = preview.files[0];
				return file ? renderFile(file, "") : "";
			}

			const noun = "files";
			const renderedFiles = preview.files.map((file) => renderFile(file, "  \u2514 ")).join("\n");
			if (renderedFiles.length > 0) {
				return `${formatPatchOperation("update")} ${preview.files.length} ${noun} ${formatLineCountSummary(preview.added, preview.removed)}\n${renderedFiles}`;
			}
		} catch {
			// fall back to manual themed line rendering
		}
	}

	return formatPatchPreview(preview, cwd, expanded)
		.split("\n")
		.map((line) => {
			const trimmed = line.trimStart();
			if (trimmed.startsWith("+")) {
				return theme.fg("toolDiffAdded", line);
			}
			if (trimmed.startsWith("-")) {
				return theme.fg("toolDiffRemoved", line);
			}
			if (trimmed.startsWith("\u2022")) {
				return theme.fg("toolTitle", theme.bold(line));
			}
			if (trimmed.startsWith("\u2514")) {
				return theme.fg("accent", line);
			}
			return theme.fg("toolDiffContext", line);
		})
		.join("\n");
}

function getApplyPatchRenderState(toolCallId: string, cwd: string, patchText: string): ApplyPatchRenderState {
	const existing = applyPatchRenderStates.get(toolCallId);
	if (existing && existing.cwd === cwd && existing.patchText === patchText) {
		return existing;
	}

	const callText = formatInFlightCallText(patchText);
	let collapsed = "";
	let expanded = "";
	try {
		const hunks = parsePatch(patchText);
		if (hunks.length > 0) {
			const files = hunks.map((hunk) => {
				const file = {
					filePath: hunk.filePath,
					operation: hunk.type,
					diff: "",
					added: 0,
					removed: 0,
				} satisfies ApplyPatchPreviewFile;
				return hunk.type === "update" && hunk.movePath !== undefined ? { ...file, movePath: hunk.movePath } : file;
			}) satisfies ApplyPatchPreviewFile[];
			const preview: ApplyPatchPreview = { files, added: 0, removed: 0 };
			collapsed = formatPatchPreview(preview, cwd, false);
			expanded = formatPatchPreview(preview, cwd, true);
		}
	} catch {
		// leave summaries empty for partial/incomplete patch text
	}

	const nextState: ApplyPatchRenderState = { cwd, patchText, callText, collapsed, expanded };
	applyPatchRenderStates.set(toolCallId, nextState);
	return nextState;
}

export function clearApplyPatchRenderState(): void {
	applyPatchRenderStates.clear();
}

function normalizeApplyPatchArguments(args: unknown): ApplyPatchParams {
	if (typeof args === "string") {
		return { input: args };
	}

	if (args && typeof args === "object" && "input" in args) {
		const input = (args as { input?: unknown }).input;
		if (typeof input === "string") {
			return { input };
		}
	}

	return { input: "" };
}

async function createPatchPreview(cwd: string, hunks: ParsedPatch[]): Promise<ApplyPatchPreview> {
	const files: ApplyPatchPreviewFile[] = [];
	for (const hunk of hunks) {
		const absolutePath = path.resolve(cwd, hunk.filePath);
		if (hunk.type === "add") {
			const oldContent = await readExistingFileForPreview(absolutePath);
			const diff = createPatchDiff(oldContent, hunk.content);
			files.push({ filePath: hunk.filePath, operation: oldContent.length > 0 ? "update" : "add", ...diff });
			continue;
		}

		if (hunk.type === "delete") {
			const oldContent = await readFile(absolutePath, "utf-8");
			const diff = createPatchDiff(oldContent, "");
			files.push({ filePath: hunk.filePath, operation: "delete", ...diff });
			continue;
		}

		const oldContent = await readFile(absolutePath, "utf-8");
		const newContent =
			hunk.chunks.length === 0 ? oldContent : replaceChunks(oldContent, hunk.filePath, hunk.chunks).content;
		if (hunk.movePath) {
			path.resolve(cwd, hunk.movePath);
		}
		const diff = createPatchDiff(oldContent, newContent);
		const file = { filePath: hunk.filePath, operation: "update", ...diff } satisfies ApplyPatchPreviewFile;
		files.push(hunk.movePath !== undefined ? { ...file, movePath: hunk.movePath } : file);
	}

	return {
		files,
		added: files.reduce((sum, file) => sum + file.added, 0),
		removed: files.reduce((sum, file) => sum + file.removed, 0),
	};
}

function formatPendingPatchPaths(patchText: string): string {
	const paths = extractPatchedPaths(patchText);
	if (paths.length === 0) {
		return "Applying patch...";
	}
	return `Applying patch...\n${paths.map((filePath) => `\u2022 ${filePath}`).join("\n")}`;
}

async function createPendingPatchUpdate(
	cwd: string,
	patchText: string,
	progress?: ApplyPatchProgress,
	previewOverride?: ApplyPatchPreview,
	parsedHunks?: ParsedPatch[],
): Promise<{ text: string; details: ApplyPatchToolDetails | undefined }> {
	const title = progress
		? `Applying patch (${progress.applied + progress.failed}/${progress.total})...`
		: "Applying patch...";
	if (previewOverride) {
		const details: ApplyPatchToolDetails = { preview: previewOverride };
		if (progress) details.progress = progress;
		return {
			text: `${title}\n${formatPatchPreview(previewOverride, cwd)}`,
			details,
		};
	}

	try {
		const hunks = parsedHunks ?? parsePatch(patchText);
		if (hunks.length === 0) {
			return { text: title, details: progress ? { progress } : undefined };
		}

		const preview = await createPatchPreview(cwd, hunks);
		if (preview.files.some((file) => file.diff.trim().length > 0)) {
			const details: ApplyPatchToolDetails = { preview };
			if (progress) details.progress = progress;
			return { text: `${title}\n${formatPatchPreview(preview, cwd)}`, details };
		}
	} catch {
		return {
			text: progress ? title : formatPendingPatchPaths(patchText),
			details: progress ? { progress } : undefined,
		};
	}

	return { text: progress ? title : formatPendingPatchPaths(patchText), details: progress ? { progress } : undefined };
}

export function createApplyPatchTool(): ToolDefinition<typeof APPLY_PATCH_PARAMS, ApplyPatchToolDetails | undefined> & {
	freeform: FreeformToolFormat;
} {
	const tool = defineTool<typeof APPLY_PATCH_PARAMS, ApplyPatchToolDetails | undefined>({
		name: "apply_patch",
		label: "ApplyPatch",
		description: APPLY_PATCH_FREEFORM_DESCRIPTION,
		parameters: APPLY_PATCH_PARAMS,
		prepareArguments: normalizeApplyPatchArguments,
		promptSnippet: "Apply Codex-format file patches with apply_patch",
		promptGuidelines: [
			"Use apply_patch for file edits instead of mutating files through bash, Python scripts, heredocs, or shell redirection.",
			"After apply_patch succeeds, do not re-read the edited files just to confirm the patch applied.",
		],
		async execute(
			_toolCallId,
			params,
			_signal,
			onUpdate,
			ctx,
		): Promise<AgentToolResult<ApplyPatchToolDetails | undefined>> {
			const normalizedParams = normalizeApplyPatchArguments(params);
			if (!normalizedParams.input) {
				throw new Error("input is required");
			}

			let parsedHunks: ParsedPatch[] | undefined;
			try {
				parsedHunks = parseNonEmptyPatch(normalizedParams.input);
			} catch {
				// createPendingPatchUpdate keeps incomplete or invalid patch text renderable.
			}
			const totalOperations = parsedHunks?.length ?? 0;
			const initialProgress = totalOperations > 0 ? { applied: 0, failed: 0, total: totalOperations } : undefined;
			const pendingUpdate = await createPendingPatchUpdate(
				ctx.cwd,
				normalizedParams.input,
				initialProgress,
				undefined,
				parsedHunks,
			);
			onUpdate?.({
				content: [{ type: "text", text: pendingUpdate.text }],
				details: pendingUpdate.details,
			});

			const preview = pendingUpdate.details?.preview;
			const result = await applyParsedPatchDetailed(
				ctx.cwd,
				parsedHunks ?? parseNonEmptyPatch(normalizedParams.input),
				async (progress) => {
					const progressUpdate = await createPendingPatchUpdate(
						ctx.cwd,
						normalizedParams.input,
						progress,
						preview,
						parsedHunks,
					);
					onUpdate?.({
						content: [{ type: "text", text: progressUpdate.text }],
						details: progressUpdate.details,
					});
				},
			);
			if (result.failures.length > 0) {
				const mustReadFiles = result.recoveryInstructions.mustReadFiles;
				const failed = mustReadFiles.join(", ");
				const mustReadText = mustReadFiles.join(" and ");
				return {
					content: [
						{
							type: "text",
							text: [
								"apply_patch partially failed.",
								`Failed: ${failed}`,
								`Recovery: MUST read ${mustReadText} before retrying.`,
								result.appliedFiles.length > 0
									? "Earlier file actions in this patch were already applied."
									: "No file actions were applied.",
								result.recoveryInstructions.mustNotReadFiles.length > 0
									? "Recovery: MUST NOT reread other files from this patch unless a specific dependency requires it."
									: "",
							]
								.filter((line) => line.length > 0)
								.join("\n"),
						},
					],
					details: { result },
				};
			}

			return {
				content: [{ type: "text", text: result.summaries.join("\n") }],
				details: { result },
			};
		},
		renderCall(args, theme, context) {
			if (!context.argsComplete) {
				return new Text(theme.fg("toolTitle", theme.bold("apply_patch: Patching")), 0, 0);
			}

			const normalizedArgs = normalizeApplyPatchArguments(args);
			const renderState = getApplyPatchRenderState(context.toolCallId, context.cwd, normalizedArgs.input);
			const text = renderState.callText.length > 0 ? `apply_patch: ${renderState.callText}` : "apply_patch";
			return new Text(theme.fg("toolTitle", theme.bold(text)), 0, 0);
		},
		renderResult(result: AgentToolResult<ApplyPatchToolDetails | undefined>, options, theme, context) {
			const component = new Container();
			const preview = result.details?.preview;
			if (preview) {
				const bgName = options.isPartial ? "toolPendingBg" : "toolSuccessBg";
				const progress = result.details?.progress;
				const title = progress
					? `Applying patch (${progress.applied + progress.failed}/${progress.total})`
					: "Applying patch";
				const box = new Box(1, 1, (text: string) => applyLayeredBackground(theme, bgName, text));
				box.addChild(new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0));
				box.addChild(new Spacer(1));
				const expanded = options.isPartial ? true : (options.expanded ?? true);
				box.addChild(new Text(renderPatchPreview(preview, context.cwd, theme, expanded), 0, 0));
				component.addChild(box);
				return component;
			}

			const text = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.filter((value): value is string => typeof value === "string" && value.length > 0)
				.join("\n");
			if (text) {
				component.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
			}
			return component;
		},
	});

	return Object.assign(tool, {
		freeform: {
			type: "grammar",
			syntax: "lark",
			definition: APPLY_PATCH_LARK_GRAMMAR,
		} satisfies FreeformToolFormat,
	});
}
