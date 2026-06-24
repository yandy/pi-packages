import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findAstGrepPathSync, resetResolvedForTests } from "../../src/ast-grep/binary";
import { runAstGrepRewrite } from "../../src/ast-grep/rewrite";

resetResolvedForTests();

describe.skipIf(findAstGrepPathSync() === null)("ast-grep rewrite integration (real binary)", () => {
	let fixtureDir: string;
	let fixtureFile: string;

	beforeAll(() => {
		fixtureDir = mkdtempSync(join(tmpdir(), "sg-rewrite-integ-"));
		fixtureFile = join(fixtureDir, "a.ts");
	});

	beforeEach(() => {
		writeFileSync(fixtureFile, 'console.log("hi");\n');
	});

	afterAll(() => {
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	it("dry-run returns replacement preview without writing files", async () => {
		const result = await runAstGrepRewrite({
			pattern: "console.log($MSG)",
			rewrite: "logger.info($MSG)",
			lang: "typescript",
			paths: [fixtureDir],
			apply: false,
		});
		expect(result.error).toBeUndefined();
		expect(result.applied).toBe(false);
		expect(result.matches.length).toBeGreaterThanOrEqual(1);
		expect(result.matches[0].replacement).toBe('logger.info("hi")');
		// file unchanged
		expect(readFileSync(fixtureFile, "utf-8")).toBe('console.log("hi");\n');
	});

	it("apply writes the replacement to disk", async () => {
		const result = await runAstGrepRewrite({
			pattern: "console.log($MSG)",
			rewrite: "logger.info($MSG)",
			lang: "typescript",
			paths: [fixtureDir],
			apply: true,
		});
		expect(result.error).toBeUndefined();
		expect(result.applied).toBe(true);
		expect(result.matches.length).toBeGreaterThanOrEqual(1);
		// file changed
		expect(readFileSync(fixtureFile, "utf-8")).toBe('logger.info("hi");\n');
	});
});
