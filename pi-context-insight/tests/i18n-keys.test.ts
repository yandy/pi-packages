import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DICT } from "../src/i18n";

const RENDER_DIR = join(process.cwd(), "src/render");

function renderSources(): Array<{ file: string; source: string }> {
	return readdirSync(RENDER_DIR)
		.filter((name) => name.endsWith(".ts"))
		.map((file) => ({ file, source: readFileSync(join(RENDER_DIR, file), "utf8") }));
}

describe("i18n key coverage", () => {
	it("every key literal used by a render module exists in both dicts", () => {
		const missing: string[] = [];
		for (const { file, source } of renderSources()) {
			for (const match of source.matchAll(/key:\s*"([a-zA-Z][\w.]*)"/g)) {
				const key = match[1] ?? "";
				if (DICT.en[key] === undefined || DICT.zh[key] === undefined) missing.push(`${file}: ${key}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("every dictionary key referenced as a label map value is defined", () => {
		const missing: string[] = [];
		for (const { file, source } of renderSources()) {
			for (const match of source.matchAll(/"([a-z][a-zA-Z]+\.[a-zA-Z][\w.]*)"/g)) {
				const key = match[1] ?? "";
				if (!key.includes(".")) continue;
				// Only bare key-shaped literals are judged; ordinary strings with dots are not keys.
				if (!/^(anchor|bar|browser|cardMeta|cat|chip|cmds|context|cost|detail|doc|empty|event|events|family|files|flag|kpi|label|notes|overview|print|rail|table|timeline|timing|tokens|toggle|warn|warning)\./.test(key)) continue;
				if (DICT.en[key] === undefined || DICT.zh[key] === undefined) missing.push(`${file}: ${key}`);
			}
		}
		expect(missing).toEqual([]);
	});
});
