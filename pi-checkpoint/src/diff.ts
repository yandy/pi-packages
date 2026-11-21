import { createGitRunner, type RunGit } from "./git.js";

const DEFAULT_PATCH_BYTES = 128 * 1024;
const SHORTSTAT_BYTES = 16 * 1024;

export interface DiffInput {
	cwd: string;
	baselineCommit: string;
	resultCommit: string;
	maxPatchBytes?: number;
	signal?: AbortSignal;
}

export interface DiffPreview {
	shortstat: string | null;
	patchPreview: string | null;
	previewTruncated: boolean;
	previewError: string | null;
}

interface PreviewPart {
	value: string | null;
	truncated: boolean;
	error: string | null;
}

export async function createDiffPreview(input: DiffInput, runGit: RunGit = createGitRunner()): Promise<DiffPreview> {
	const commonArgs = [
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		input.baselineCommit,
		input.resultCommit,
		"--",
	];
	const [shortstat, patch] = await Promise.all([
		runPreviewPart(
			"shortstat",
			["diff", "--shortstat", ...commonArgs],
			input,
			runGit,
			SHORTSTAT_BYTES,
			false,
		),
		runPreviewPart(
			"patch",
			["diff", "--patch", ...commonArgs],
			input,
			runGit,
			input.maxPatchBytes ?? DEFAULT_PATCH_BYTES,
			true,
		),
	]);
	return {
		shortstat: shortstat.value?.trim() ?? null,
		patchPreview: patch.value,
		previewTruncated: patch.truncated,
		previewError: [shortstat.error, patch.error].filter(Boolean).join("; ") || null,
	};
}

async function runPreviewPart(
	label: "shortstat" | "patch",
	args: string[],
	input: DiffInput,
	runGit: RunGit,
	maxOutputBytes: number,
	allowTruncated: boolean,
): Promise<PreviewPart> {
	try {
		const result = await runGit(args, {
			cwd: input.cwd,
			env: { LC_ALL: "C" },
			signal: input.signal,
			allowNonZeroExit: true,
			maxOutputBytes,
		});
		if (allowTruncated && result.truncated) {
			return { value: utf8Prefix(result.stdout, maxOutputBytes), truncated: true, error: null };
		}
		if (result.code !== 0 || result.killed || result.truncated) {
			return {
				value: null,
				truncated: false,
				error: `${label}: ${cleanError(result.stderr || `git diff exited with ${result.code ?? "unknown"}`)}`,
			};
		}
		return { value: result.stdout, truncated: false, error: null };
	} catch (error) {
		return { value: null, truncated: false, error: `${label}: ${cleanError(error)}` };
	}
}

function cleanError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

function utf8Prefix(value: string, maxBytes: number): string {
	let bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes && !value.endsWith("�")) return value;
	bytes = bytes.subarray(0, maxBytes);
	while (bytes.length > 0) {
		const text = bytes.toString("utf8");
		if (!text.endsWith("�")) return text;
		bytes = bytes.subarray(0, bytes.length - 1);
	}
	return "";
}
