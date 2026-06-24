import type { CliMatch, SgResult } from "./ast-grep/types";

export function formatSearchResult(result: SgResult): string {
	if (result.error) return `Error: ${result.error}`;
	if (result.matches.length === 0) return "No matches found";

	// group by file
	const byFile = new Map<string, CliMatch[]>();
	for (const m of result.matches) {
		const arr = byFile.get(m.file) ?? [];
		arr.push(m);
		byFile.set(m.file, arr);
	}

	const lines: string[] = [];
	lines.push(`${result.matches.length} match(es) • ${byFile.size} file(s)`);
	for (const [file, ms] of byFile) {
		lines.push(`${file} (${ms.length} match${ms.length > 1 ? "es" : ""})`);
		for (const m of ms) {
			const loc = `${m.range.start.line + 1}:${m.range.start.column + 1}`;
			lines.push(`  ${m.file}:${loc}  ${m.lines.trim()}`);
		}
	}
	if (result.truncated) {
		lines.push(`(truncated, ${result.totalMatches} total)`);
	}
	return lines.join("\n");
}
