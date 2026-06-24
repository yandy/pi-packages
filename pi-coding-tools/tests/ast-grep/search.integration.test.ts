import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findAstGrepPathSync, resetResolvedForTests } from "../../src/ast-grep/binary";
import { runAstGrep } from "../../src/ast-grep/search";

// Clear cached binary resolution so detection is fresh.
resetResolvedForTests();

// Skip the whole suite when no ast-grep binary is available (e.g. CI without it).
describe.skipIf(findAstGrepPathSync() === null)("ast-grep integration (real binary)", () => {
	let fixtureDir: string;
	let fixtureFile: string;

	beforeAll(() => {
		fixtureDir = mkdtempSync(join(tmpdir(), "sg-integ-"));
		fixtureFile = join(fixtureDir, "a.ts");
		writeFileSync(fixtureFile, 'console.log("hi");\n');
	});

	afterAll(() => {
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	it("finds a console.log with a meta-variable pattern", async () => {
		const result = await runAstGrep({
			pattern: "console.log($MSG)",
			lang: "typescript",
			paths: [fixtureDir],
		});
		expect(result.error).toBeUndefined();
		expect(result.matches.length).toBeGreaterThanOrEqual(1);
		expect(result.matches[0].file.endsWith("a.ts")).toBe(true);
	});
});
