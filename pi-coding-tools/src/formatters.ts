import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliMatch, CliRewriteMatch, SgResult, SgRewriteResult } from "./ast-grep/types";
import type { DocumentSymbol, Hover, Location, LocationLink, SymbolInformation } from "./lsp/types";
import { symbolKindName } from "./lsp/types";

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

function isDocumentSymbol(s: DocumentSymbol | SymbolInformation): s is DocumentSymbol {
	return "range" in s && "selectionRange" in s;
}

function renderSymbolNode(s: DocumentSymbol, prefix: string, isLast: boolean): string[] {
	const branch = isLast ? "└──" : "├──";
	const kind = symbolKindName(s.kind).toLowerCase();
	const detail = s.detail ? `  ${s.detail}` : "";
	const lines = [`${prefix}${branch} ${kind} ${s.name}${detail}`];
	const childPrefix = prefix + (isLast ? "    " : "│   ");
	const children = s.children ?? [];
	children.forEach((c, i) => {
		lines.push(...renderSymbolNode(c, childPrefix, i === children.length - 1));
	});
	return lines;
}

export function formatSymbolTree(symbols: Array<DocumentSymbol | SymbolInformation>, filePath: string): string {
	const lines: string[] = [filePath];
	const docs = symbols.filter(isDocumentSymbol) as DocumentSymbol[];
	const flat = symbols.filter((s) => !isDocumentSymbol(s)) as SymbolInformation[];
	for (let i = 0; i < docs.length; i++) {
		lines.push(...renderSymbolNode(docs[i], "", i === docs.length - 1));
	}
	for (const s of flat) {
		const kind = symbolKindName(s.kind).toLowerCase();
		lines.push(`├── ${kind} ${s.name}`);
	}
	return lines.join("\n");
}

// Strip markdown noise (code fences, stray backticks) so the LLM gets a clean
// signature/type line instead of fenced markdown — saves tokens and matches
// the package's compact-output principle.
function stripMarkdown(text: string): string {
	let out = text;
	// Remove fenced code blocks ```lang ... ```, keep inner content joined
	out = out.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (_, body) => body.trim());
	// Remove remaining standalone fence markers
	out = out.replace(/```/g, "");
	// Inline `code` → code (drop single backticks around a span)
	out = out.replace(/`([^`\n]+)`/g, "$1");
	// Collapse 3+ blank lines to one, trim trailing whitespace per line
	out = out
		.split("\n")
		.map((l) => l.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return out;
}

export function formatHover(hover: Hover): string {
	if (!hover) return "No hover information at this position.";
	const c = hover.contents;
	let text: string;
	if (typeof c === "string") text = c;
	else if (Array.isArray(c)) text = c.map((x) => (typeof x === "string" ? x : x.value)).join("\n");
	else text = c.value;
	const stripped = stripMarkdown(text);
	return stripped || "No hover information at this position.";
}

function uriToRelPath(uri: string, rootDir: string): string {
	try {
		const abs = fileURLToPath(uri);
		const rel = relative(rootDir, abs);
		return rel || abs;
	} catch {
		return uri;
	}
}

function formatLocation(loc: Location, rootDir: string): string {
	const p = uriToRelPath(loc.uri, rootDir);
	return `${p}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
}

export function formatNavigate(
	operation: "definition" | "references",
	result: Location | LocationLink | Array<Location | LocationLink> | null,
	rootDir: string,
): string {
	if (!result || (Array.isArray(result) && result.length === 0)) {
		return operation === "definition" ? "No definition found." : "No references found.";
	}
	const locs: Location[] = [];
	const arr = Array.isArray(result) ? result : [result];
	for (const r of arr) {
		if ("uri" in r) locs.push(r as Location);
		else if ("targetUri" in r) locs.push({ uri: (r as LocationLink).targetUri, range: (r as LocationLink).targetRange });
	}
	if (operation === "definition") {
		return `definition →\n${locs.map((l) => `  ${formatLocation(l, rootDir)}`).join("\n")}`;
	}
	return `references (${locs.length}) →\n${locs.map((l) => `  ${formatLocation(l, rootDir)}`).join("\n")}`;
}

export function formatRewriteResult(result: SgRewriteResult): string {
	if (result.error) return `Error: ${result.error}`;
	if (result.matches.length === 0) return "No matches found";

	const byFile = new Map<string, CliRewriteMatch[]>();
	for (const m of result.matches) {
		const arr = byFile.get(m.file) ?? [];
		arr.push(m);
		byFile.set(m.file, arr);
	}

	const lines: string[] = [];
	if (result.applied) {
		lines.push(`Applied ${result.matches.length} change(s) across ${byFile.size} file(s)`);
		for (const [file, ms] of byFile) {
			lines.push(`${file} (${ms.length} change${ms.length > 1 ? "s" : ""})`);
		}
	} else {
		lines.push(`${result.matches.length} match(es) \u2022 ${byFile.size} file(s) [dry-run, no files written]`);
		for (const [file, ms] of byFile) {
			lines.push(`${file} (${ms.length} match${ms.length > 1 ? "es" : ""})`);
			for (const m of ms) {
				const loc = `${m.range.start.line + 1}:${m.range.start.column + 1}`;
				lines.push(`  ${m.file}:${loc}  - ${m.text.trim()}`);
				lines.push(`  ${" ".repeat(m.file.length + loc.length + 6)}+ ${m.replacement.trim()}`);
			}
		}
	}
	if (result.truncated) {
		lines.push(`(truncated, ${result.totalMatches} total)`);
	}
	return lines.join("\n");
}
