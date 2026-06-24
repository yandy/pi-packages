import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findAstGrepPathSync, resetResolvedForTests } from "../../src/ast-grep/binary";
import { runAstGrep } from "../../src/ast-grep/search";

// Clear cached binary resolution so detection is fresh.
resetResolvedForTests();

const astGrepAvailable = findAstGrepPathSync() !== null;
const skipOrRun = astGrepAvailable ? it : it.skipIf(!astGrepAvailable);

describe("ast-grep integration (real binary)", () => {
	const fixtureDir = mkdtempSync(join(tmpdir(), "sg-integ-"));
	const fixtureFile = join(fixtureDir, "a.ts");
	writeFileSync(fixtureFile, 'console.log("hi");\n');

	afterAll(() => {
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	skipOrRun("finds a console.log with a meta-variable pattern", async () => {
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
