import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { langFromEnv, parseInsightArgs, runInsight } from "../src/command";
import { fakeContext } from "./helpers/ctx";
import { assistantEntry, resetEntryIds, systemEntry, userEntry } from "./helpers/entries";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-insight-v2-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("parseInsightArgs", () => {
	it("defaults to a full report", () => {
		expect(parseInsightArgs("")).toEqual({ mode: "full" });
	});
	it("parses --short and a path", () => {
		expect(parseInsightArgs("out.html --short")).toEqual({ mode: "short", path: "out.html" });
	});
	it("parses --lang", () => {
		expect(parseInsightArgs("--lang zh")).toEqual({ mode: "full", lang: "zh" });
	});
	it("rejects unknown options", () => {
		expect(() => parseInsightArgs("--nope")).toThrow(/--short/);
	});
	it("rejects two positional paths", () => {
		expect(() => parseInsightArgs("a.html b.html")).toThrow(/only one output path/);
	});
	it("rejects an unsupported language", () => {
		expect(() => parseInsightArgs("--lang de")).toThrow(/--lang/);
	});
});

describe("langFromEnv", () => {
	it("detects chinese locales", () => {
		expect(langFromEnv({ LANG: "zh_CN.UTF-8" })).toBe("zh");
		expect(langFromEnv({ LC_ALL: "zh_TW" })).toBe("zh");
	});
	it("ignores other locales", () => {
		expect(langFromEnv({ LANG: "en_US.UTF-8" })).toBeUndefined();
		expect(langFromEnv({})).toBeUndefined();
	});
});

describe("runInsight", () => {
	function session() {
		resetEntryIds();
		return [
			systemEntry({ sections: { preamble: "base" }, timestamp: 1 }),
			userEntry("sentinel-user-text", 2),
			assistantEntry({ content: [{ type: "text", text: "sentinel-answer-text" }], timestamp: 3 }),
		];
	}

	it("writes a full report with raw content", async () => {
		const path = await runInsight("report.html", fakeContext({ entries: session() }, { cwd: root }));
		const html = readFileSync(join(root, "report.html"), "utf8");
		expect(path).toBe(join(root, "report.html"));
		expect(html).toContain("sentinel-user-text");
		expect(html).toContain("insight-payload");
	});
	it("writes a short report without any sentinel text", async () => {
		await runInsight("short.html --short", fakeContext({ entries: session() }, { cwd: root }));
		const html = readFileSync(join(root, "short.html"), "utf8");
		expect(html).not.toContain("sentinel-user-text");
		expect(html).not.toContain("sentinel-answer-text");
	});
	it("refuses an empty session", async () => {
		resetEntryIds();
		await expect(
			runInsight("", fakeContext({ entries: [systemEntry({ sections: { preamble: "b" }, timestamp: 1 })] }, { cwd: root })),
		).rejects.toThrow(/Nothing to report/);
	});
});
